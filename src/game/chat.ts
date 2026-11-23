// Office chat: an all-staff channel plus a direct message with each person.
// Staff complain on their own while things are broken (it's demoralizing, on purpose), and
// answer your questions from the real state of their machine. Personalities differ.

import type { Office, Person } from '../content/office';
import { formatIp } from '../sim/ip';
import type { Network } from '../sim/network';
import type { Rng } from '../sim/rng';
import { COWORKERS, OWEN_TIPS, type CoworkerId } from './coworkers';

export type ConvId = string; // 'all' or a person's PC id
export const ALL = 'all';

export interface ChatMessage {
  t: number;
  /** 'you', 'system', or the sender's PC id. */
  from: string;
  text: string;
}

export interface Conversation {
  id: ConvId;
  messages: ChatMessage[];
  /** Number of messages the player has seen. */
  read: number;
}

export type Persona = 'helpful' | 'impatient' | 'clueless' | 'ghost';

/** Fixed per person (set in the office content), so the same colleague behaves the same way every shift. */
export function personaOf(p: Person): Persona {
  return p.persona;
}

interface Outgoing {
  at: number;
  conv: ConvId;
  from: string;
  text: string;
  /** Something the person physically does when they send this. */
  effect?: 'plug-cable';
}

export interface ChatState {
  convs: Record<ConvId, Conversation>;
  outbox: Outgoing[];
  nextComplaint: Record<string, number>;
  complaints: Record<string, number>;
  calmUntil: number;
  askedCable: Record<string, number>;
  /** Per-conversation memory, so replies follow the flow of the chat. */
  talk?: Record<string, Talk>;
  /** Owen's random facts: when the next one comes, and which he's already told you. */
  nextTipAt?: number;
  tipsUsed?: number[];
  /** Tickets Owen already nudged you on. */
  hinted?: string[];
  /** When people waiting to hear back will next ask about their ticket. */
  nag?: Record<string, number>;
}

interface Talk {
  /** What the person last asked you: 'need' (did you need something?), 'about' (is this about my PC?), 'check' (what should I check?). */
  asked: 'need' | 'about' | 'check' | null;
  /** Messages in a row they didn't understand. */
  confused: number;
}

type Reply = { text: string; effect?: Outgoing['effect']; asks?: Talk['asked'] } | null;

const SEC = 1000;
const MIN = 60 * SEC;
const NIC = 'FastEthernet0';

const COMPLAINTS: Record<string, string[]> = {
  internet: [
    'Is the internet down for anyone else?',
    'Why is internet down???',
    'This internet sucks . . .',
    'Seriously, the internet AGAIN?',
    "I can't send anything to clients. Is someone fixing this??",
  ],
  files: ['S: drive just disappeared on me', "Can't open any client files. Is the S: drive down?", 'S: DRIVE. PLEASE.', 'I had a file open and it just died. S: drive is gone.'],
  ledger: ['LedgerWorks won\'t load', "LedgerWorks keeps timing out, I'm losing my work", 'Is LedgerWorks down or is it just me'],
  dns: ["Outlook keeps saying it can't find the server?", "Getting weird 'domain not available' errors on login"],
  print: ['Printer is offline again', 'Why can I never print when I actually need to', "Printer's down. Again. Of course."],
};
const FED_UP = ['Is IT even here today?', 'Anyone know who to call about this?', "I'm going to get nothing done today.", 'Cool. Love this. Very productive day.'];
const PILE_ON = ['Same here', 'mine too', '+1', 'same', 'Yep, nothing works over here either', 'Glad it\'s not just me'];
const NAGS = [
  'Any update on my ticket? I still haven\'t heard anything.',
  'Hi, is someone looking at my issue? Nobody got back to me.',
  'Just checking, is my problem fixed yet? I don\'t want to restart again and lose stuff.',
  'Still waiting to hear back about my ticket...',
];
const THANKS: Record<Persona, string[]> = {
  helpful: ['Oh great, thank you! Back to work.', 'Perfect, thanks so much!', 'Confirmed, it works. Thank you!'],
  impatient: ['Finally. Thanks.', 'About time. OK.', 'Fine, working now.'],
  clueless: ['Oh! So I can use it now? Great, thanks!', 'Wait, it was broken? Ha. OK thanks!', 'Thank you! What did you do?'],
  ghost: ['k', 'thx'],
};
const BACK = ["ok it's back", 'finally.', 'Working again, thanks whoever fixed it', 'about time'];

export class Chat {
  state: ChatState;

  constructor(
    private readonly net: Network,
    private readonly office: Office,
    private readonly rng: Rng,
    /** Broken service ids per present user (from the latest service check). */
    private readonly broken: () => Record<string, string[]>,
    state?: ChatState,
    /** The most urgent open ticket and its hint, for when you ask Owen for help. */
    private readonly urgentTicket: () => { id: string; hint: string } | null = () => null,
    /** People whose problem was fixed but who haven't been told yet. */
    private readonly waiting: () => Set<string> = () => new Set(),
  ) {
    this.state = state ?? { convs: {}, outbox: [], nextComplaint: {}, complaints: {}, calmUntil: 0, askedCable: {} };
    this.conv(ALL);
  }

  conv(id: ConvId): Conversation {
    return (this.state.convs[id] ??= { id, messages: [], read: 0 });
  }

  person(pcId: string): Person | undefined {
    return this.office.people.find((p) => p.pcId === pcId);
  }

  unread(id: ConvId): number {
    const c = this.state.convs[id];
    return c ? c.messages.length - c.read : 0;
  }

  totalUnread(): number {
    return Object.keys(this.state.convs).reduce((n, id) => n + this.unread(id), 0);
  }

  markRead(id: ConvId): void {
    const c = this.conv(id);
    c.read = c.messages.length;
  }

  private post(conv: ConvId, from: string, text: string): void {
    this.conv(conv).messages.push({ t: this.net.time, from, text });
  }

  private queue(conv: ConvId, from: string, text: string, delayMs: number, effect?: Outgoing['effect']): void {
    this.state.outbox.push({ at: this.net.time + delayMs, conv, from, text, effect });
  }

  /** A coworker messages you directly. */
  coworkerSay(id: CoworkerId, text: string): void {
    this.post(`cw:${id}`, `cw:${id}`, text);
  }

  /** Called every tick while the shift runs. */
  update(): void {
    const now = this.net.time;
    const s = this.state;

    // Owen shares something useful every so often. Teaching is part of his job.
    if (s.nextTipAt === undefined) s.nextTipAt = now + this.rng.int(10 * MIN, 18 * MIN);
    if (now >= s.nextTipAt) {
      const used = (s.tipsUsed ??= []);
      const left = OWEN_TIPS.map((_, i) => i).filter((i) => !used.includes(i));
      if (left.length) {
        const i = this.rng.pick(left);
        used.push(i);
        this.coworkerSay('owen', OWEN_TIPS[i]);
      }
      s.nextTipAt = now + this.rng.int(15 * MIN, 28 * MIN);
    }

    // Deliver queued messages.
    s.outbox.sort((a, b) => a.at - b.at);
    while (s.outbox.length && s.outbox[0].at <= now) {
      const m = s.outbox.shift()!;
      if (m.effect === 'plug-cable') {
        const link = this.net.linkAt(m.from, NIC);
        if (link && link.cable === 'unplugged') {
          link.cable = 'ok';
          this.net.commit();
        }
      }
      this.post(m.conv, m.from, m.text);
    }

    // Complaints from people who can't work.
    const broken = this.broken();
    const affected = Object.keys(broken);
    const calm = now < s.calmUntil;
    for (const pcId of affected) {
      if (s.nextComplaint[pcId] === undefined) {
        s.nextComplaint[pcId] = now + this.rng.int(20 * SEC, 90 * SEC) * (calm ? 4 : 1);
        continue;
      }
      if (now < s.nextComplaint[pcId]) continue;
      const count = (s.complaints[pcId] ?? 0) + 1;
      s.complaints[pcId] = count;
      const service = broken[pcId][0];
      const text = count >= 3 && this.rng.chance(0.5) ? this.rng.pick(FED_UP) : this.rng.pick(COMPLAINTS[service] ?? FED_UP);
      const toAll = this.rng.chance(0.65);
      this.post(toAll ? ALL : pcId, pcId, text);
      if (toAll && affected.length >= 3 && this.rng.chance(0.5)) {
        const other = this.rng.pick(affected.filter((id) => id !== pcId));
        if (other) this.queue(ALL, other, this.rng.pick(PILE_ON), this.rng.int(5 * SEC, 20 * SEC));
      }
      const gap = this.rng.int(3 * MIN, 7 * MIN) * (calm ? 2.5 : 1);
      s.nextComplaint[pcId] = now + gap;
    }

    // People whose problem was fixed but nobody told them: they sit tight and eventually ask.
    const waiting = this.waiting();
    const nag = (s.nag ??= {});
    for (const pcId of waiting) {
      if (broken[pcId]) continue;
      if (nag[pcId] === undefined) {
        nag[pcId] = now + this.rng.int(3 * MIN, 6 * MIN);
        continue;
      }
      if (now < nag[pcId]) continue;
      const p = this.person(pcId);
      if (p && !(personaOf(p) === 'ghost' && !this.rng.chance(0.3))) this.post(pcId, pcId, this.rng.pick(NAGS));
      nag[pcId] = now + this.rng.int(5 * MIN, 9 * MIN);
    }
    for (const pcId of Object.keys(nag)) if (!waiting.has(pcId)) delete nag[pcId];

    // People whose problem went away (and who weren't waiting on a ticket of their own).
    for (const pcId of Object.keys(s.nextComplaint)) {
      if (broken[pcId]) continue;
      if (waiting.has(pcId)) {
        delete s.nextComplaint[pcId];
        continue;
      }
      if ((s.complaints[pcId] ?? 0) > 0 && this.rng.chance(0.4)) {
        this.queue(ALL, pcId, this.rng.pick(BACK), this.rng.int(10 * SEC, 60 * SEC));
      }
      delete s.nextComplaint[pcId];
      delete s.complaints[pcId];
    }
  }

  /** You tell someone (or everyone) that their problem is fixed. They thank you and get back to work. */
  notifyFixed(pcId: string, text: string, how: 'direct' | 'everyone'): void {
    const conv = how === 'direct' ? pcId : ALL;
    this.post(conv, 'you', text);
    this.markRead(conv);
    if (how === 'everyone') this.state.calmUntil = this.net.time + 20 * MIN;
    delete this.state.nag?.[pcId];
    delete this.state.complaints[pcId];
    const p = this.person(pcId);
    if (!p) return;
    const persona = personaOf(p);
    const reply = THANKS[persona] ? this.rng.pick(THANKS[persona]) : 'Thanks!';
    this.queue(conv, pcId, reply, persona === 'ghost' ? this.rng.int(2 * MIN, 6 * MIN) : this.rng.int(8 * SEC, 40 * SEC));
  }

  /** You send a message. Announcements to everyone calm complaints down for a while. */
  send(conv: ConvId, text: string): void {
    const clean = text.trim();
    if (!clean) return;
    this.post(conv, 'you', clean);
    this.markRead(conv);
    if (conv === ALL) {
      this.announce();
      return;
    }
    if (conv.startsWith('cw:')) {
      this.coworkerReply(conv.slice(3) as CoworkerId, clean.toLowerCase());
      return;
    }
    const p = this.person(conv);
    if (!p) return;
    const persona = personaOf(p);
    if (persona === 'ghost' && !this.rng.chance(0.15)) return;
    const talk = ((this.state.talk ??= {})[p.pcId] ??= { asked: null, confused: 0 });
    const reply = this.converse(p, persona, clean.toLowerCase(), talk);
    if (!reply) return; // e.g. you said "ok": nothing to answer
    talk.asked = reply.asks ?? null;
    const delay = persona === 'ghost' ? this.rng.int(2 * MIN, 5 * MIN) : this.rng.int(6 * SEC, 25 * SEC);
    this.queue(conv, p.pcId, reply.text, delay, reply.effect);
  }

  /** Coworkers answer briefly. Owen will nudge you once per ticket; after that you're on your own. */
  private coworkerReply(id: CoworkerId, text: string): void {
    const conv = `cw:${id}`;
    const delay = this.rng.int(15 * SEC, 60 * SEC);
    const thanks = /\b(thanks|thank you|thx|ty|appreciate)\b/.test(text);
    if (thanks) {
      this.queue(conv, conv, { jordan: 'np', owen: 'Anytime.', gloria: 'Mm-hm.' }[id], delay);
      return;
    }
    if (/^(ok|okay|k|cool|got it|will do)\W*$/.test(text)) return;
    if (id === 'jordan') {
      this.queue(conv, conv, this.rng.pick(["No idea, honestly. Ask Owen?", "I'm stuck on my own stuff right now, sorry.", "Have you tried looking at the switch port? That's usually where I start."]), delay);
      return;
    }
    if (id === 'gloria') {
      this.queue(conv, conv, "I'm in meetings most of the day. If it's critical, escalate the ticket to me properly.", delay);
      return;
    }
    const urgent = this.urgentTicket();
    const hinted = (this.state.hinted ??= []);
    if (urgent && !hinted.includes(urgent.id)) {
      hinted.push(urgent.id);
      this.queue(conv, conv, `For ${urgent.id}: ${urgent.hint}`, delay);
      return;
    }
    this.queue(conv, conv, urgent ? "You've got this. If you're really stuck, escalate it to me." : 'Quiet right now. Good time to write some notes.', delay);
  }

  /** Display name for a sender id ('you', a coworker, or a staff PC id). */
  nameOf(from: string): string {
    if (from === 'you') return 'You';
    if (from.startsWith('cw:')) return COWORKERS.find((c) => `cw:${c.id}` === from)?.name ?? from;
    return this.person(from)?.name ?? from;
  }

  private announce(): void {
    const now = this.net.time;
    this.state.calmUntil = now + 12 * MIN;
    for (const pcId of Object.keys(this.state.nextComplaint)) {
      this.state.nextComplaint[pcId] = Math.max(this.state.nextComplaint[pcId], now + this.rng.int(4 * MIN, 9 * MIN));
    }
    const affected = Object.keys(this.broken());
    const responders = this.rng.shuffle([...affected]).slice(0, this.rng.int(0, 2));
    for (const pcId of responders) {
      const p = this.person(pcId);
      if (!p) continue;
      const byPersona: Record<Persona, string[]> = {
        helpful: ['Thanks for the update!', 'Thank you!'],
        impatient: ['how long??', 'Any ETA? I have a client call at 2.'],
        clueless: ['Is it the wifi?', 'Should we restart our computers?'],
        ghost: ['k'],
      };
      this.queue(ALL, pcId, this.rng.pick(byPersona[personaOf(p)]), this.rng.int(10 * SEC, 40 * SEC));
    }
  }

  /**
   * Conversational moves first (goodbyes, thanks, "ok", yes/no to their question, "hold on"),
   * then technical questions answered from the PC's real state, then a fallback that
   * gets shorter instead of repeating itself.
   */
  private converse(p: Person, persona: Persona, raw: string, talk: Talk): Reply {
    const text = raw.replace(/[^\w\s'/.?]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = text.split(' ').filter(Boolean).length;
    const broken = (this.broken()[p.pcId] ?? []).length > 0;
    const has = (re: RegExp) => re.test(text);
    const pick = (by: Record<Persona, string>) => by[persona];
    const thanks = has(/\b(thanks|thank you|thx|ty|appreciate it|cheers)\b/);
    const understood = (r: Reply): Reply => {
      talk.confused = 0;
      return r;
    };

    // Wrapping up.
    const closing =
      has(/\b(that'?s (all|it|everything)|never ?mind|nvm|no worries|all good|bye|ttyl|talk (to you )?later|have a good (one|day|night))\b/) ||
      (has(/^(nope|no|nah)\b/) && talk.asked === 'need' && words <= 6);
    if (closing) {
      return understood({
        text: broken
          ? pick({
              helpful: "Ok! Let me know when it's working, I'm kind of stuck until then.",
              impatient: 'Ok, but I still can\'t work. Please fix it.',
              clueless: 'Ok! Thanks for trying!',
              ghost: 'ok',
            })
          : pick({ helpful: thanks ? 'Sounds good, thanks!' : 'Sounds good, have a good one!', impatient: 'k.', clueless: 'Ok, bye!', ghost: 'k' }),
      });
    }

    // Short yes/no answers to something they asked.
    if (words <= 4 && talk.asked) {
      if (has(/^(yes|yeah|yep|yup|ya|correct|it is|sure)\b/)) {
        if (talk.asked === 'about') return understood({ text: broken ? "Great, it's still not working. What should I do?" : 'Oh, it\'s working fine right now actually. What\'s up?', asks: 'check' });
        if (talk.asked === 'need') return understood({ text: pick({ helpful: "Sure, what's up?", impatient: 'Ok, what is it?', clueless: 'Ok! What do you need?', ghost: '?' }), asks: 'check' });
      }
      if (has(/^(no|nope|nah)\b/) && talk.asked === 'about') return understood({ text: 'Oh, ok. What\'s up then?', asks: 'need' });
    }

    // Technical questions: answered from the real machine.
    const tech = this.reply(p, persona, text);
    if (tech) return understood(tech);

    if (has(/\b(hold on|one sec|one second|one moment|give me a (sec|second|minute|min)|working on it|looking into it|on it|bear with)\b/)) {
      return understood({ text: broken ? pick({ helpful: 'Ok, thank you!', impatient: 'Please hurry.', clueless: 'Ok!', ghost: 'k' }) : 'No rush!' });
    }
    if (has(/\b(you there|are you there|still there)\b/)) return understood({ text: 'Yep, here.' });
    if (has(/\b(sorry|my bad|apologies)\b/)) return understood({ text: 'No worries.' });
    if (thanks) {
      return understood({
        text: broken
          ? pick({ helpful: 'No problem! Hope it\'s fixed soon.', impatient: 'Sure. Is it fixed yet?', clueless: "You're welcome!", ghost: 'np' })
          : pick({ helpful: 'No problem!', impatient: 'Yep.', clueless: 'Anytime!', ghost: 'np' }),
      });
    }
    // "ok", "cool", "got it": people don't answer those.
    if (has(/^(ok|okay|k|kk|cool|great|perfect|alright|got it|sounds good|will do|noted|sure|np|nice)$/)) return null;
    if (has(/^(hi|hello|hey)\b/)) {
      const asks = persona === 'helpful' ? 'about' : 'need';
      return understood({ text: pick({ helpful: 'Hi! Is this about my computer?', impatient: 'Yes?', clueless: 'Hello!', ghost: 'hi' }), asks });
    }

    // Didn't understand: say so once, then stop replying instead of looping.
    talk.confused++;
    if (talk.confused === 1) {
      if (!broken) return { text: "Everything's fine on my end. Did you need something?", asks: 'need' };
      return {
        text: pick({
          helpful: 'Sure, what should I check?',
          impatient: "I just need it working, I've got a deadline.",
          clueless: "Sorry, I'm not really a computer person.",
          ghost: '?',
        }),
        asks: persona === 'helpful' ? 'check' : null,
      };
    }
    if (talk.confused === 2) return { text: pick({ helpful: "Sorry, I'm not sure what you mean?", impatient: '??', clueless: "I don't understand, sorry.", ghost: '?' }) };
    return null;
  }

  /** Technical answers, built from what's actually true on the person's PC. Null if the message isn't technical. */
  private reply(p: Person, persona: Persona, text: string): Reply {
    const net = this.net;
    const pc = net.device(p.pcId);
    const link = net.linkAt(p.pcId, NIC);
    const nic = pc.nic;
    const up = net.isUp(p.pcId, NIC);
    const brokenServices = this.broken()[p.pcId] ?? [];
    const broken = brokenServices.length > 0;
    const has = (re: RegExp) => re.test(text);

    if (has(/cable|plug|unplug|cord|wire/)) {
      if (link?.cable === 'unplugged') {
        const asked = (this.state.askedCable[p.pcId] = (this.state.askedCable[p.pcId] ?? 0) + 1);
        if (persona === 'helpful') return { text: 'Oh! The cable was just lying on the floor behind the tower. Plugged it back in.', effect: 'plug-cable' };
        if (persona === 'clueless' && asked < 2) return { text: 'Which cable? There are like five back there.' };
        if (persona === 'clueless') return { text: 'I plugged the blue one back in, it was loose. Is that the right one?', effect: 'plug-cable' };
        if (persona === 'impatient' && asked < 2) return { text: "Yes it's plugged in. Can you just fix it?" };
        return { text: 'Fine, I looked. ...It was unplugged. Plugged it in.', effect: 'plug-cable' };
      }
      if (link?.cable === 'cut') return { text: "It's plugged in on both ends. The cable looks pretty beat up under my desk though, my chair rolls over it." };
      if (!link) return { text: 'There\'s a cable in the wall but nothing in my computer? I just moved here.' };
      return { text: persona === 'impatient' ? 'Yes. It is plugged in.' : "Yep, it's plugged in." };
    }
    if (has(/light|led|blink|green|orange/)) {
      if (up) return { text: "There's a green light and an orange one blinking on the back." };
      return { text: persona === 'clueless' ? "I don't see any lights? Is it supposed to have lights?" : 'No lights at all where the cable goes in.' };
    }
    if (has(/driver|device manager|adapter/)) {
      if (persona === 'clueless') return { text: "What's a device manager? Sorry." };
      if (nic?.driver === 'missing') return { text: "In Device Manager there's 'Ethernet Controller' with a yellow triangle, under 'Other devices'." };
      if (nic?.driver === 'outdated') return { text: "The network adapter has a yellow triangle. It says 'This device cannot start. (Code 10)'." };
      if (nic?.disabled) return { text: 'The network thing has a little down arrow on it. Says disabled?' };
      return { text: "It says 'This device is working properly.'" };
    }
    if (has(/ipconfig|ip address|\bip\b/)) {
      if (persona === 'clueless') return { text: 'How do I do that? Is it in the start menu?' };
      if (nic && (nic.driver === 'missing' || nic.disabled)) return { text: "I typed ipconfig and it just says 'Windows IP Configuration' and nothing else?" };
      if (!up) return { text: "It says 'Media disconnected'?" };
      const ip = pc.running.interfaces[NIC]?.ip;
      const gw = pc.running.defaultGateway;
      return { text: `It says IPv4 ${ip ? formatIp(ip.address) : 'nothing'}, gateway ${gw !== null ? formatIp(gw) : 'blank'}.` };
    }
    if (has(/restart|reboot|turn it off/)) {
      return { text: broken ? 'I already restarted it twice. Still nothing.' : 'Restarted. Seems fine?' };
    }
    if (has(/work(ing)?\b|try (it )?again|test|fixed|better|now\?/)) {
      if (broken) return { text: persona === 'impatient' ? 'Still broken.' : 'Still nothing, sorry.' };
      return { text: persona === 'impatient' ? 'Finally. Thanks.' : "Yep, it's working now! Thank you!" };
    }
    if (has(/where|desk|sit|moved/)) return { text: `I'm at desk ${p.desk}.` };
    if (has(/wifi|wireless/)) return { text: "We have wifi? I'm just using the cable." };
    return null;
  }
}
