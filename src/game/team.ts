// Your team. For now that's the intern (from Tier 2): they pick up new tickets that match your runbooks, in the order
// of the priority YOU set, type the runbook's commands (with typos, depending on skill), and resolve the ticket only
// if the network says it's fixed; otherwise they hand it back with a log. Each employee keeps their own shift score.
// An intern who scores 200+ in 5 shifts in a row becomes a Tier 1 NOC tech and earns you 1,000 points; one who
// doesn't within 15 shifts leaves. Training happens in real time and earns made-up NetSmart certificates.

import type { Rng } from '../sim/rng';
import { adviceFor } from './docfacts';
import { faultById } from './faults';
import type { Game } from './game';
import type { Ticket } from './queue';
import { commandsOf, matchRunbook, runRunbook, type RunbookSource } from './runbooks';
import type { Difficulty } from './scoring';
import { ticketTopics, TOPICS, type Topic } from './topics';

const MIN = 60_000;

export const INTERN_TERM_SHIFTS = 15;
export const INTERN_BAR = 200;
export const INTERN_STREAK = 5;
export const INTERN_PROMOTION_REWARD = 1000;
/** Rank index from which you can take on an intern (Tier 2). */
export const INTERN_FROM_RANK = 1;
/** More tickets than this in a shift wears people down. */
const OVERWORK = 8;

export interface Cert {
  id: string;
  name: string;
  level: 'easy' | 'moderate' | 'hard';
  /** Real time it takes (while the game is running). */
  realMs: number;
  requires?: string;
  about: string;
  typoMult: number;
  speedMult: number;
  notices?: boolean;
}

export const CERTS: Cert[] = [
  { id: 'NSCT', name: 'NetSmart Certified Technician', level: 'easy', realMs: 10 * MIN, about: 'Console basics, show commands, reading error messages.', typoMult: 0.75, speedMult: 1, notices: true },
  { id: 'NSCA', name: 'NetSmart Certified Associate', level: 'moderate', realMs: 60 * MIN, requires: 'NSCT', about: 'VLANs, trunks, DHCP, ACL basics: the everyday NOC work.', typoMult: 0.6, speedMult: 0.8 },
  { id: 'NSCS', name: 'NetSmart Certified Security Specialist', level: 'hard', realMs: 120 * MIN, requires: 'NSCA', about: 'ACLs, port security, DHCP snooping, DAI, hardening.', typoMult: 0.8, speedMult: 0.9 },
  { id: 'NSCP', name: 'NetSmart Certified Professional', level: 'hard', realMs: 240 * MIN, requires: 'NSCA', about: 'Dynamic routing, STP and EtherChannel, backups and upgrades.', typoMult: 0.5, speedMult: 0.7 },
];

/** Topic skill (0-100) each certificate adds. */
export const CERT_TOPICS: Record<string, Partial<Record<Topic, number>>> = {
  NSCT: { physical: 20, endpoints: 20, switching: 10 },
  NSCA: { switching: 25, dhcpdns: 25, acl: 15, nat: 15, routing: 10, ops: 10 },
  NSCS: { acl: 25, security: 35, ops: 10 },
  NSCP: { routing: 35, stp: 30, ops: 20, switching: 10 },
};

/** A new intern knows a little about cables and PCs and next to nothing else. */
export const INTERN_SKILLS: Record<Topic, number> = { physical: 15, endpoints: 15, switching: 10, stp: 5, dhcpdns: 5, routing: 5, acl: 5, nat: 5, security: 5, ops: 5 };

/** Skill a ticket's topics need, by difficulty, for an even chance. */
const NEEDS: Record<Difficulty, number> = { trivial: 10, easy: 25, moderate: 45, hard: 65, expert: 80 };
/** Game minutes to work a ticket without a runbook, before skill. */
const OWN_MINUTES: Record<Difficulty, number> = { trivial: 6, easy: 10, moderate: 18, hard: 30, expert: 45 };
/** Picks tickets up without being told only when at least this likely to fix them. */
export const CONFIDENT = 0.7;

/** Learning by doing: points per topic for working an incident. Tickets that span topics teach more about each. */
export function learnPerTopic(topics: number): number {
  return topics >= 3 ? 4 : topics === 2 ? 3 : 2;
}

export type Focus = 'anything' | 'p1' | 'told' | Topic;

export type EmployeeStatus =
  | { kind: 'idle' }
  | { kind: 'working'; ticketId: string; runbookId: string; runbookTitle: string; doneAt: number }
  | { kind: 'investigating'; ticketId: string; doneAt: number }
  | { kind: 'training'; cert: string; remainingRealMs: number };

export interface Employee {
  id: string;
  name: string;
  role: 'intern' | 'tech';
  title: string;
  /** Chance of a typo in each command. */
  typoRate: number;
  /** Game minutes per command (plus a couple of minutes reading the ticket and the runbook). */
  minutesPerCommand: number;
  /** Notices an error message and retypes the command. */
  noticesErrors: boolean;
  morale: number;
  certs: string[];
  status: EmployeeStatus;
  /** Runbooks they brought with them: you can read them, they use them, they leave with them. */
  ownRunbooks: RunbookSource[];
  /** Their own score per shift number. */
  shiftPoints: Record<number, number>;
  lifetimePoints: number;
  resolved: number;
  handedBack: number;
  typos: number;
  /** Tickets worked this shift (for overwork). */
  workedThisShift: number;
  /** Interns: the shift they started, and shifts in a row at the promotion bar. */
  startShift: number;
  qualifying: number;
  promotedFromIntern?: boolean;
  /** Skill per topic, 0-100. */
  skills?: Partial<Record<Topic, number>>;
  /** What they pick up on their own without a runbook. */
  focus?: Focus;
  /** Login name on the network devices (shows in "Configured from console by ..."). */
  user?: string;
}

/** An employee's skill in a topic (older saves get theirs from their certificates). */
export function skillOf(e: Employee, topic: Topic): number {
  if (!e.skills) {
    e.skills = { ...INTERN_SKILLS };
    for (const c of e.certs) for (const [t, v] of Object.entries(CERT_TOPICS[c] ?? {})) e.skills[t as Topic] = Math.min(100, (e.skills[t as Topic] ?? 0) + v!);
  }
  return e.skills[topic] ?? 0;
}

/** Their skill for a ticket: the weakest of its topics (you need all of them to fix it). */
export function skillFor(e: Employee, t: Ticket): number {
  const topics = ticketTopics(t.draft);
  if (!topics.length) return Math.round(TOPICS.reduce((a, x) => a + skillOf(e, x.id), 0) / TOPICS.length);
  return Math.min(...topics.map((x) => skillOf(e, x)));
}

/** Chance they fix a ticket without a runbook, including what your docs did for them. */
export function chanceToFix(e: Employee, t: Ticket, game: Game): number {
  const base = 0.5 + (skillFor(e, t) - NEEDS[t.difficulty]) / 40;
  const docs = adviceFor(game, t);
  const p = base + docs.bonus - (docs.stale ? 0.35 : 0);
  return Math.max(0.03, Math.min(0.95, p));
}

const userName = (name: string) => {
  const [first, ...rest] = name.toLowerCase().split(' ');
  return `${first[0]}${rest.join('')}`.replace(/[^a-z]/g, '');
};

export interface TeamState {
  employees: Employee[];
  seq: number;
  /** Things that happened, newest last (shown in the Team view). */
  history: { t: number; text: string }[];
}

const INTERN_NAMES = ['Alex Moreno', 'Priya Shah', 'Jamie Park', 'Taylor Brooks', 'Devon Lee', 'Casey Nguyen', 'Riley Adams', 'Morgan Diaz', 'Sam Ortiz', 'Avery Chen'];

export class Team {
  state: TeamState = { employees: [], seq: 1, history: [] };
  /** Messages for the UI toast. */
  fresh: string[] = [];

  get employees(): Employee[] {
    return this.state.employees;
  }

  intern(): Employee | undefined {
    return this.employees.find((e) => e.role === 'intern');
  }

  private say(now: number, text: string): void {
    this.state.history.push({ t: now, text });
    if (this.state.history.length > 100) this.state.history.shift();
    this.fresh.push(text);
  }

  /** Why you can't take on an intern right now, or null if you can. */
  internBlocked(game: Game): string | null {
    if (game.inPlacement) return 'Not during the placement shift.';
    if (game.queue.rankIndex < INTERN_FROM_RANK) return 'Interns are assigned from Tier 2. Write your runbooks now so they have something to follow.';
    if (this.intern()) return 'You already have an intern.';
    return null;
  }

  takeIntern(game: Game, rng: Rng): Employee | null {
    if (this.internBlocked(game)) return null;
    const used = new Set(this.employees.map((e) => e.name));
    const name = rng.pick(INTERN_NAMES.filter((n) => !used.has(n))) ?? 'Alex Moreno';
    const e: Employee = {
      id: `e${this.state.seq++}`,
      name,
      role: 'intern',
      title: 'NOC Intern',
      typoRate: 0.08,
      minutesPerCommand: 0.6,
      noticesErrors: false,
      morale: 70,
      certs: [],
      status: { kind: 'idle' },
      ownRunbooks: [],
      shiftPoints: {},
      lifetimePoints: 0,
      resolved: 0,
      handedBack: 0,
      typos: 0,
      workedThisShift: 0,
      startShift: game.queue.shift,
      qualifying: 0,
      skills: { ...INTERN_SKILLS },
      focus: 'anything',
      user: userName(name),
    };
    this.employees.push(e);
    this.say(game.net.time, `${name} started as your intern. They'll pick up tickets that match your runbooks.`);
    return e;
  }

  find(id: string): Employee | undefined {
    return this.employees.find((e) => e.id === id);
  }

  /** The runbooks an employee can follow: their own first, then yours. */
  runbooksFor(e: Employee, game: Game): RunbookSource[] {
    return [...e.ownRunbooks, ...game.notes.filter((n) => n.runbook)];
  }

  shiftScore(e: Employee, shift: number): number {
    return e.shiftPoints[shift] ?? 0;
  }

  /** Called every tick while a shift runs: pick up work, finish work. */
  update(game: Game): void {
    const now = game.net.time;
    const q = game.queue;
    for (const e of this.employees) {
      const st = e.status;
      if (st.kind === 'investigating') {
        const t = q.tickets.find((x) => x.id === st.ticketId);
        if (!t || !q.isOpen(t) || t.assignedTo !== e.name) {
          e.status = { kind: 'idle' };
          continue;
        }
        if (now < st.doneAt) continue;
        e.status = { kind: 'idle' };
        e.workedThisShift++;
        this.finishOwn(game, e, t);
        continue;
      }
      if (st.kind === 'working') {
        const t = q.tickets.find((x) => x.id === st.ticketId);
        if (!t || !q.isOpen(t) || t.assignedTo !== e.name) {
          e.status = { kind: 'idle' };
          continue;
        }
        if (now < st.doneAt) continue;
        const rb = this.runbooksFor(e, game).find((r) => r.id === st.runbookId);
        e.status = { kind: 'idle' };
        e.workedThisShift++;
        if (!rb) {
          t.assignedTo = undefined;
          t.activity.push({ t: now, who: 'senior', name: e.name, text: `The runbook "${st.runbookTitle}" is gone, so I'm handing this back.` });
          continue;
        }
        const log = runRunbook(game.net, game.office, rb.body, t, { typoRate: e.typoRate, noticesErrors: e.noticesErrors, rng: game.net.rng });
        this.learn(game, e, t);
        t.runLog = log;
        e.typos += log.filter((l) => l.meant !== undefined).length;
        game.net.commit();
        if (t.draft.check()) {
          const pts = q.resolveByEmployee(t.id, e.name, `Fixed it by following your runbook "${rb.title}". (${log.length} commands, log attached.)`);
          e.shiftPoints[q.shift] = (e.shiftPoints[q.shift] ?? 0) + pts;
          e.lifetimePoints += pts;
          e.resolved++;
          this.say(now, `${e.name} resolved ${t.id} with "${rb.title}" (+${pts}).`);
          this.message(e, `${t.id} is fixed with "${rb.title}" and ${t.draft.reporter.name} knows.`);
        } else {
          t.assignedTo = undefined;
          e.handedBack++;
          t.activity.push({ t: now, who: 'senior', name: e.name, text: `Followed "${rb.title}" but it's still broken. Handing it back to you; the log of what I typed is attached.` });
          this.say(now, `${e.name} couldn't fix ${t.id} with "${rb.title}" and handed it back.`);
          this.message(e, `"${rb.title}" didn't fix ${t.id}. Handed it back with my log.`);
        }
        continue;
      }
      if (st.kind !== 'idle') continue;
      // Pick up the next unclaimed ticket, in the order of the priority YOU gave them: with a matching runbook if
      // there is one, otherwise on their own if it's in their focus and they're confident they can fix it.
      const books = this.runbooksFor(e, game);
      const focus = e.focus ?? 'anything';
      const waiting = q
        .openTickets()
        .filter((t) => (t.status === 'new' || t.status === 'reopened') && !t.assignedTo && !t.escalation && t.seniorAt === null)
        .sort((a, b) => a.priority - b.priority || a.openedAt - b.openedAt);
      for (const t of waiting) {
        const rb = books.length ? matchRunbook(books, t) : null;
        if (rb) {
          this.assign(game, e, t.id, rb);
          break;
        }
        if (focus === 'told') continue;
        if (focus === 'p1' && t.priority !== 1) continue;
        if (focus !== 'anything' && focus !== 'p1' && !ticketTopics(t.draft).includes(focus)) continue;
        if (chanceToFix(e, t, game) < CONFIDENT) continue;
        this.takeOwn(game, e, t.id);
        break;
      }
    }
  }

  /** Works a ticket without a runbook: how long depends on difficulty and skill; good docs speed it up. */
  takeOwn(game: Game, e: Employee, ticketId: string): string | null {
    const q = game.queue;
    const t = q.tickets.find((x) => x.id === ticketId);
    if (!t || !q.isOpen(t)) return 'That ticket is closed.';
    if (e.status.kind !== 'idle') return `${e.name} is busy.`;
    if (t.assignedTo) return `${t.assignedTo} is already on it.`;
    if (t.escalation) return 'That ticket is escalated.';
    q.acknowledge(t.id);
    t.assignedTo = e.name;
    t.runbook = undefined;
    const skill = skillFor(e, t);
    const docs = adviceFor(game, t);
    const minutes = OWN_MINUTES[t.difficulty] * (1.5 - skill / 200) * (docs.bonus > 0 ? 0.85 : 1);
    t.activity.push({ t: game.net.time, who: 'senior', name: e.name, text: 'Picked this up. Looking into it.' });
    e.status = { kind: 'investigating', ticketId: t.id, doneAt: game.net.time + Math.round(minutes * MIN) };
    this.message(e, `Picked up ${t.id} (${t.draft.subject}). On it.`);
    return null;
  }

  /** The end of working a ticket on their own: fixed, handed back, or (juniors, sometimes) made worse. */
  private finishOwn(game: Game, e: Employee, t: Ticket): void {
    const q = game.queue;
    const now = game.net.time;
    const rng = game.net.rng;
    const p = chanceToFix(e, t, game);
    const docs = adviceFor(game, t);
    this.learn(game, e, t);
    if (rng.chance(p)) {
      t.draft.fix();
      game.net.commit();
      if (t.draft.check()) {
        const pts = q.resolveByEmployee(t.id, e.name, `Fixed it. ${t.draft.explain}`);
        e.shiftPoints[q.shift] = (e.shiftPoints[q.shift] ?? 0) + pts;
        e.lifetimePoints += pts;
        e.resolved++;
        this.say(now, `${e.name} resolved ${t.id} on their own (+${pts}).`);
        this.message(e, `${t.id} is fixed and ${t.draft.reporter.name} knows. ${t.draft.explain}`);
        return;
      }
    }
    t.assignedTo = undefined;
    e.handedBack++;
    const why = docs.stale
      ? `I went by ${docs.stale.where}: it says ${docs.stale.says}, but that's not what's on the network. Couldn't find the problem.`
      : skillFor(e, t) < NEEDS[t.difficulty]
        ? `This one's past me, I don't know ${ticketTopics(t.draft).map((x) => TOPICS.find((y) => y.id === x)!.short).join(' / ') || 'this area'} well enough yet.`
        : "Couldn't find it. Handing it back.";
    // Juniors out of their depth sometimes poke at the wrong thing. They don't mention it.
    const worse = skillFor(e, t) < NEEDS[t.difficulty] - 15 && rng.chance(0.3) ? this.makeWorse(game, e, t, docs.stale?.port ?? null) : false;
    void worse;
    t.activity.push({ t: now, who: 'senior', name: e.name, text: why });
    this.say(now, `${e.name} couldn't fix ${t.id} and handed it back.`);
    this.message(e, `Handing ${t.id} back. ${why}`);
  }

  /** Bounced the reporter's switch port (or the one your stale docs pointed to) and left it shut. */
  private makeWorse(game: Game, e: Employee, t: Ticket, docPort: { sw: string; port: string } | null): boolean {
    const net = game.net;
    const peer = net.peerOf(t.draft.reporter.pcId, 'FastEthernet0');
    const target = docPort ?? (peer && (peer.device === 'acc1' || peer.device === 'acc2') ? { sw: peer.device, port: peer.iface } : null);
    if (!target) return false;
    const ifc = net.device(target.sw).running.interfaces[target.port];
    if (!ifc || ifc.shutdown) return false;
    faultById('port-shut').inject(net, { sw: target.sw, port: target.port, pc: t.draft.reporter.pcId });
    net.log(target.sw, `%SYS-5-CONFIG_I: Configured from console by ${e.user ?? 'intern'} on vty0 (10.10.99.50)`);
    return true;
  }

  /** Learning by doing: every ticket they work raises its topics; tickets that span topics teach more. */
  learn(game: Game, e: Employee, t: Ticket): void {
    const topics = ticketTopics(t.draft);
    if (!topics.length) return;
    const per = learnPerTopic(topics.length);
    const parts: string[] = [];
    for (const x of topics) {
      const before = skillOf(e, x);
      const after = Math.min(100, before + per);
      e.skills![x] = after;
      if (after > before) parts.push(`${TOPICS.find((y) => y.id === x)!.short} +${after - before}%`);
    }
    if (parts.length) {
      const text = `${e.name} learned from ${t.id}: ${parts.join(', ')}.`;
      this.say(game.net.time, text);
    }
  }

  /**
   * You message an employee. Rule-based, short and literal: "take INC-1004", "use <runbook> on INC-1004", "drop it",
   * "status", "skills", "train NSCA", "focus on printers" / "only P1s" / "anything" / "only when I tell you".
   */
  chatReply(game: Game, e: Employee, raw: string): string | null {
    const text = raw.toLowerCase().trim();
    const q = game.queue;
    const st = e.status;
    const ticketRef = text.match(/\b(inc|chg)[-\s]?(\d{3,5})\b/);
    const ticketId = ticketRef ? `${ticketRef[1].toUpperCase()}-${ticketRef[2]}` : null;
    const doing = () =>
      st.kind === 'working'
        ? `Working ${st.ticketId} with your runbook "${st.runbookTitle}".`
        : st.kind === 'investigating'
          ? `Looking into ${st.ticketId} on my own.`
          : st.kind === 'training'
            ? `Studying for ${st.cert}, about ${Math.ceil(st.remainingRealMs / MIN)} more real minutes.`
            : 'Free. Nothing on my plate.';
    if (/^(thanks|thank you|thx|ty|nice|good job|great|well done)\b/.test(text)) return e.role === 'intern' ? 'Thanks!! :)' : 'Thanks.';
    if (/^(ok|okay|k|cool|got it)\W*$/.test(text)) return null;
    const useMatch = text.match(/^use (.+?) (?:on|for) (?:inc|chg)/);
    if (useMatch && ticketId) {
      const want = useMatch[1].replace(/^(the |runbook |your )+/, '').replace(/["']/g, '').trim();
      const rb = this.runbooksFor(e, game).find((r) => r.title.toLowerCase().includes(want));
      if (!rb) return `I can't find a runbook called "${want}".`;
      return this.assign(game, e, ticketId, rb) ?? `On it: ${ticketId} with "${rb.title}".`;
    }
    if (/\b(take|grab|pick up|work on|look at|handle)\b/.test(text) && ticketId) {
      const t = q.tickets.find((x) => x.id === ticketId);
      if (!t) return `I don't see ${ticketId} in the queue.`;
      const books = this.runbooksFor(e, game);
      const rb = books.length ? matchRunbook(books, t) : null;
      const err = rb ? this.assign(game, e, ticketId, rb) : this.takeOwn(game, e, ticketId);
      if (err) return err;
      const p = chanceToFix(e, t, game);
      return rb ? `On it, "${rb.title}" fits that one.` : p < 0.4 ? `OK, I'll try. Honestly not sure I can fix this one.` : 'On it.';
    }
    if (/\b(drop|stop|leave it|hand it back|give it back)\b/.test(text)) {
      if (st.kind !== 'working' && st.kind !== 'investigating') return "I'm not working on anything.";
      const t = q.tickets.find((x) => x.id === st.ticketId);
      if (t) {
        t.assignedTo = undefined;
        t.activity.push({ t: game.net.time, who: 'senior', name: e.name, text: 'Dropped this, as asked.' });
      }
      e.status = { kind: 'idle' };
      return `Dropped ${st.ticketId}.`;
    }
    const train = text.match(/\btrain(?:ing)?\b.*\b(nsct|nsca|nscs|nscp)\b/);
    if (train) return this.train(e.id, train[1].toUpperCase(), game.net.time) ?? `Starting ${train[1].toUpperCase()} now. I'll be offline from tickets until it's done.`;
    if (/\b(only when i (tell|ask)|wait for me|don't pick|do not pick|nothing on your own)\b/.test(text)) {
      e.focus = 'told';
      return "OK, I'll only take what you hand me (and tickets your runbooks match).";
    }
    if (/\b(only p1s?|p1s? only|just p1s?|only critical)\b/.test(text)) {
      e.focus = 'p1';
      return "OK, I'll only pick up P1s on my own.";
    }
    if (/\b(anything|whatever|any ticket|all tickets)\b/.test(text)) {
      e.focus = 'anything';
      return "OK, I'll pick up anything I'm confident about.";
    }
    const focus = text.match(/\b(?:focus on|stick to|only do|only)\s+(.+)/);
    if (focus) {
      const topic = topicFromWords(focus[1]);
      if (!topic) return `Not sure what you mean by "${focus[1]}". Try printers, cabling, VLANs, DHCP, DNS, routing, ACLs, NAT, security, STP or backups.`;
      e.focus = topic;
      return `OK, I'll stick to ${TOPICS.find((x) => x.id === topic)!.name.toLowerCase()} on my own.`;
    }
    if (/\b(skills?|good at|strong|weak)\b/.test(text)) {
      const ranked = TOPICS.map((x) => ({ x, v: skillOf(e, x.id) })).sort((a, b) => b.v - a.v);
      const top = ranked.slice(0, 3).map((r) => `${r.x.short} ${r.v}%`).join(', ');
      const low = ranked.slice(-2).map((r) => `${r.x.short} ${r.v}%`).join(', ');
      return `Best at: ${top}. Weakest: ${low}.`;
    }
    if (/\b(status|what are you|busy|doing|free|up to)\b/.test(text)) return doing();
    return 'Not sure what you mean. I can: take INC-1004, use <runbook> on INC-1004, drop it, status, skills, train NSCA, focus on printers / only P1s / anything / only when you tell me.';
  }

  /** Sends you a chat message from an employee (set by the game). */
  onMessage?: (employeeId: string, text: string) => void;

  message(e: Employee, text: string): void {
    this.onMessage?.(e.id, text);
  }

  /** Puts an employee on a ticket with a runbook (automatically by trigger, or by you). */
  assign(game: Game, e: Employee, ticketId: string, rb: RunbookSource): string | null {
    const q = game.queue;
    const t = q.tickets.find((x) => x.id === ticketId);
    if (!t || !q.isOpen(t)) return 'That ticket is closed.';
    if (e.status.kind !== 'idle') return `${e.name} is busy.`;
    if (t.assignedTo) return `${t.assignedTo} is already on it.`;
    if (t.escalation) return 'That ticket is escalated.';
    const n = commandsOf(rb.body).length;
    if (!n) return `"${rb.title}" has no commands marked.`;
    q.acknowledge(t.id);
    t.assignedTo = e.name;
    t.runbook = rb.title;
    t.activity.push({ t: game.net.time, who: 'senior', name: e.name, text: `Picked this up with the runbook "${rb.title}".` });
    this.message(e, `Picked up ${t.id} (${t.draft.subject}) with your runbook "${rb.title}".`);
    e.status = { kind: 'working', ticketId: t.id, runbookId: rb.id, runbookTitle: rb.title, doneAt: game.net.time + Math.round((2 + n * e.minutesPerCommand) * MIN) };
    return null;
  }

  /** End of a shift: intern promotion or end of term, morale and quitting. */
  endShift(game: Game, rng: Rng): void {
    const q = game.queue;
    const now = game.net.time;
    for (const e of [...this.employees]) {
      const pts = this.shiftScore(e, q.shift);
      if (e.role === 'intern') {
        e.qualifying = pts >= INTERN_BAR ? e.qualifying + 1 : 0;
        if (e.qualifying >= INTERN_STREAK) {
          e.role = 'tech';
          e.title = 'Tier 1 NOC Technician';
          e.typoRate = Math.max(0.01, e.typoRate * 0.5);
          e.noticesErrors = true;
          e.promotedFromIntern = true;
          e.morale = Math.min(100, e.morale + 20);
          q.addPoints(`${e.name} promoted to Tier 1 NOC`, INTERN_PROMOTION_REWARD);
          this.say(now, `${e.name} made it: ${INTERN_STREAK} shifts in a row at ${INTERN_BAR}+. Promoted to Tier 1 NOC Technician. +${INTERN_PROMOTION_REWARD} for you.`);
        } else if (q.shift - e.startShift + 1 >= INTERN_TERM_SHIFTS) {
          this.remove(e);
          this.say(now, `${e.name}'s ${INTERN_TERM_SHIFTS}-shift internship ended without a promotion. They left. You can take on a new intern.`);
          continue;
        }
      }
      e.morale = Math.max(0, Math.min(100, e.morale + (e.workedThisShift > OVERWORK ? -10 : 3)));
      e.workedThisShift = 0;
      if (e.morale < 20 && rng.chance(0.5)) {
        this.remove(e);
        this.say(now, `${e.name} quit.${e.ownRunbooks.length ? ' Their runbooks went with them.' : ''}`);
      }
    }
  }

  private remove(e: Employee): void {
    this.state.employees = this.state.employees.filter((x) => x !== e);
  }

  fire(id: string, now: number): void {
    const e = this.find(id);
    if (!e) return;
    this.remove(e);
    this.say(now, `You let ${e.name} go.${e.ownRunbooks.length ? ' Their runbooks left with them.' : ''}`);
  }

  promote(id: string, now: number): string | null {
    const e = this.find(id);
    if (!e) return 'No such employee.';
    if (e.role === 'intern') return `Interns are promoted by results: ${INTERN_BAR}+ points in ${INTERN_STREAK} shifts in a row.`;
    if (e.title === 'Tier 2 NOC Technician') return 'Higher titles come with the budget.';
    e.title = 'Tier 2 NOC Technician';
    e.morale = Math.min(100, e.morale + 15);
    this.say(now, `You promoted ${e.name} to Tier 2 NOC Technician.`);
    return null;
  }

  demote(id: string, now: number): string | null {
    const e = this.find(id);
    if (!e) return 'No such employee.';
    if (e.role === 'intern' || e.title === 'Tier 1 NOC Technician') return "There's nothing lower to demote them to.";
    e.title = 'Tier 1 NOC Technician';
    e.morale = Math.max(0, e.morale - 30);
    this.say(now, `You demoted ${e.name}. They're not happy about it.`);
    return null;
  }

  train(id: string, certId: string, now: number): string | null {
    const e = this.find(id);
    const c = CERTS.find((x) => x.id === certId);
    if (!e || !c) return 'No such employee or certificate.';
    if (e.certs.includes(c.id)) return `${e.name} already has ${c.id}.`;
    if (c.requires && !e.certs.includes(c.requires)) return `${c.id} requires ${c.requires} first.`;
    if (e.status.kind === 'working') return `${e.name} is in the middle of a ticket.`;
    if (e.status.kind === 'training') return `${e.name} is already training.`;
    e.status = { kind: 'training', cert: c.id, remainingRealMs: c.realMs };
    this.say(now, `${e.name} started training for ${c.name} (${c.id}). No tickets until it's done.`);
    return null;
  }

  /** Real time passing (only while the game runs): training counts down. */
  tickReal(ms: number, now: number): void {
    for (const e of this.employees) {
      const st = e.status;
      if (st.kind !== 'training') continue;
      st.remainingRealMs -= ms;
      if (st.remainingRealMs > 0) continue;
      const c = CERTS.find((x) => x.id === st.cert)!;
      skillOf(e, 'physical');
      for (const [t, v] of Object.entries(CERT_TOPICS[c.id] ?? {})) e.skills![t as Topic] = Math.min(100, skillOf(e, t as Topic) + v!);
      e.certs.push(c.id);
      e.typoRate = Math.max(0.005, e.typoRate * c.typoMult);
      e.minutesPerCommand = Math.max(0.15, e.minutesPerCommand * c.speedMult);
      if (c.notices) e.noticesErrors = true;
      e.morale = Math.min(100, e.morale + 10);
      e.status = { kind: 'idle' };
      this.say(now, `${e.name} passed ${c.name} (${c.id}).`);
    }
  }

  exportState(): TeamState {
    return structuredClone(this.state);
  }

  importState(s: TeamState | undefined): void {
    if (s) this.state = s;
  }
}

/** Words you might use for a topic in chat. */
export function topicFromWords(words: string): Topic | null {
  const w = words.toLowerCase();
  const table: [RegExp, Topic][] = [
    [/print|pc|desk|driver|endpoint|computer/, 'endpoints'],
    [/cabl|physical|hardware|nic|fiber|fibre/, 'physical'],
    [/vlan|trunk|switchport|port/, 'switching'],
    [/stp|spanning|etherchannel|loop/, 'stp'],
    [/dhcp|dns/, 'dhcpdns'],
    [/rout|ospf|bgp|eigrp|rip/, 'routing'],
    [/acl|access.list|filter/, 'acl'],
    [/nat|pat|internet/, 'nat'],
    [/secur|snoop|dai|harden|password/, 'security'],
    [/backup|upgrade|ops|operation|monitor/, 'ops'],
  ];
  return table.find(([re]) => re.test(w))?.[1] ?? null;
}
