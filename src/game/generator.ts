// The fault generator: builds incidents out of real fault building blocks (faults.ts) instead of hand-written
// templates. It picks a fault that fits the rank, puts it somewhere it can really happen, sometimes adds related
// faults or a red herring, then breaks the network and writes the ticket from what actually broke for real people,
// in the reporter's own voice. Fixed means every hurt user has their services back, however you got there.

import type { Person } from '../content/office';
import { dhcpRequest } from '../sim/dhcp';
import type { Rng } from '../sim/rng';
import { canMakeChange } from './access';
import { faultById, FAULTS, type Fault, type Site } from './faults';
import type { Difficulty, Priority } from './scoring';
import { brokenServices } from './services';
import { freePeople, person, withAwake, type Env, type Params, type TemplateContext, type TicketDraft, type TicketTemplate } from './ticketKit';

export const GENERATED_ID = 'generated';
/** Share of new incidents that come from the generator (the rest are hand-built tickets). */
export const GENERATED_SHARE = 0.6;

const ORDER: Difficulty[] = ['trivial', 'easy', 'moderate', 'hard', 'expert'];

interface Atom {
  id: string;
  site: Site;
}

const ACTORS = [
  { user: 'jreyes', ip: '10.10.99.23', who: 'Jordan' },
  { user: 'dlindqvist', ip: '10.10.99.21', who: 'the contractor (dlindqvist)' },
  { user: 'msp-secops', ip: '10.10.99.27', who: "the MSP's security team" },
  { user: 'tbrennan', ip: '10.10.99.30', who: 'Tom Brennan, the office manager, who knows the shared admin password' },
];

/** Plausible guesses users make that have nothing to do with the real cause. */
const HERRINGS = [
  'IT pushed a Windows update last night, maybe that broke it?',
  'The cleaners were in here this morning, not sure if they unplugged something.',
  "It started right after I opened a really big Excel file.",
  'I think it might be the new mouse I got yesterday.',
  'There was a power flicker around 7, maybe related?',
  "My antivirus popped up something about a threat earlier. Could that be it?",
];

const SERVICE_WORDS: Record<string, string> = {
  internet: 'the internet',
  files: 'the S: drive',
  ledger: 'LedgerWorks',
  dns: 'signing in to anything',
  print: 'printing',
};

// ---------------------------------------------------------------- planning

function pickWeighted<T>(rng: Rng, items: { item: T; weight: number }[]): T | null {
  const live = items.filter((x) => x.weight > 0);
  if (!live.length) return null;
  return rng.weighted(live);
}

function closeness(d: Difficulty, wanted: Difficulty): number {
  const dist = Math.abs(ORDER.indexOf(d) - ORDER.indexOf(wanted));
  return [1, 0.35, 0.08, 0.02, 0.01][dist];
}

/**
 * Plans a generated incident for this rank, or null if nothing fits right now. The plan is plain JSON (fault ids,
 * sites, reporter) so it survives a save.
 */
export function planGenerated(ctx: TemplateContext, wanted: Difficulty, rankIndex: number): Params | null {
  const rng = ctx.rng;
  const people = freePeople(ctx).map((p) => p.pcId);
  if (!people.length) return null;
  // Config changes need someone who can log in. Once outsiders are locked out, only Jordan makes changes, and he
  // rarely breaks things, so config faults get much less common.
  const outsidersIn = (dev: string) => ACTORS.some((a) => a.user !== 'jreyes' && canMakeChange(ctx.net, a.user, dev));
  const options = FAULTS.map((f) => ({ f, sites: f.sites(ctx.net, ctx.office, people) }))
    .map((x) => ({ ...x, sites: x.f.configOn ? x.sites.filter((s) => outsidersIn(x.f.configOn!(s)) || rng.chance(0.3)) : x.sites }))
    .filter((x) => x.sites.length);
  const primary = pickWeighted(rng, options.map((x) => ({ item: x, weight: x.f.weight * closeness(x.f.difficulty, wanted) })));
  if (!primary) return null;
  const site = rng.pick(primary.sites);
  const reporters = primary.f.victims(ctx.net, ctx.office, site).filter((pc) => people.includes(pc));
  if (!reporters.length) return null;
  const pcId = rng.pick(reporters);
  const atoms: Atom[] = [{ id: primary.f.id, site }];
  const used = new Set(primary.f.resources(site));

  // Higher ranks get compound problems: a second (or third) fault, preferably on the same person's path.
  const extra = rankIndex === 0 ? 0 : rankIndex === 1 ? (rng.chance(0.25) ? 1 : 0) : rankIndex === 2 ? (rng.chance(0.5) ? 1 : 0) : rng.chance(0.15) ? 2 : rng.chance(0.5) ? 1 : 0;
  for (let i = 0; i < extra; i++) {
    const pool = options
      .filter((x) => !atoms.some((a) => a.id === x.f.id) && ORDER.indexOf(x.f.difficulty) <= ORDER.indexOf(wanted))
      .flatMap((x) => x.sites.filter((s) => x.f.resources(s).every((r) => !used.has(r))).map((s) => ({ f: x.f, s, mine: x.f.victims(ctx.net, ctx.office, s).includes(pcId) })));
    const pick = pickWeighted(rng, pool.map((x) => ({ item: x, weight: x.f.weight * (x.mine ? 3 : 0.4) })));
    if (!pick) break;
    atoms.push({ id: pick.f.id, site: pick.s });
    pick.f.resources(pick.s).forEach((r) => used.add(r));
  }

  const hardest = Math.max(...atoms.map((a) => ORDER.indexOf(faultById(a.id).difficulty)));
  const diff = ORDER[Math.min(ORDER.length - 1, hardest + (atoms.length > 1 ? 1 : 0))];
  const herring = rankIndex >= 2 && rng.chance(0.4) ? rng.int(0, HERRINGS.length - 1) : -1;
  const hasConfig = atoms.some((a) => faultById(a.id).configOn);
  // Whoever made the change must still be able to log in to every device it touched.
  const devices = atoms.map((a) => faultById(a.id).configOn?.(a.site)).filter((d): d is string => !!d);
  const able = ACTORS.map((a, i) => ({ a, i })).filter(({ a }) => devices.every((d) => canMakeChange(ctx.net, a.user, d)));
  const outsiders = able.filter(({ a }) => a.user !== 'jreyes');
  const actor = !hasConfig ? -1 : outsiders.length && rng.chance(0.75) ? rng.pick(outsiders).i : (able.find(({ a }) => a.user === 'jreyes')?.i ?? 0);
  return { atoms: JSON.stringify(atoms), pcId, diff, herring, actor, variant: rng.int(0, 2) };
}

// ---------------------------------------------------------------- ticket text

function list(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function cap(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function subjectFor(lost: string[], scope: number): string {
  const everything = ['internet', 'files', 'ledger'].every((x) => lost.includes(x));
  const where = scope >= 5 ? ' for everyone' : scope >= 2 ? ' for a few of us' : '';
  if (everything) return `Nothing works${where || ' at my desk'}`;
  if (lost.length === 1 && lost[0] === 'print') return scope >= 2 ? 'Printer offline for our floor' : "Can't print";
  if (lost.length === 1 && lost[0] === 'internet') return `No internet${where}`;
  if (lost.length === 1 && lost[0] === 'files') return `S: drive not working${where}`;
  if (lost.length === 1 && lost[0] === 'ledger') return `LedgerWorks won't connect${where}`;
  return `${cap(list(lost.map((x) => SERVICE_WORDS[x]).filter(Boolean)))} not working${where}`;
}

function describe(p: Person, lost: string[], scope: number, variant: number, herring: number, deskNote: string | null): string {
  const things = list(lost.map((x) => SERVICE_WORDS[x]).filter(Boolean));
  const everything = ['internet', 'files', 'ledger'].every((x) => lost.includes(x));
  const what = everything ? 'nothing works: no internet, no S: drive, LedgerWorks won\'t open' : `${things} ${lost.length === 1 ? "isn't" : "aren't"} working`;
  const others = scope >= 5 ? 'Everyone around me has the same problem.' : scope >= 2 ? 'A couple of people near me have it too.' : 'Everyone else seems fine.';
  const guess = herring >= 0 ? ` ${HERRINGS[herring]}` : '';
  const note = deskNote ? ` ${deskNote}` : '';
  switch (p.persona) {
    case 'impatient':
      return [`${cap(what)}. AGAIN. ${others} I have client deadlines today.${guess}`, `Since this morning ${what}. ${others} How long is this going to take?${guess}`, `${cap(what)} and I need it now. ${others}${guess}`][variant % 3] + note;
    case 'clueless':
      return [`Hi, my computer isn't working right. I think ${what}? I'm not sure what I did.${guess}`, `Something is wrong with the computer. ${cap(what)}, I think. ${others}${guess}`, `The computer stopped doing the thing. ${cap(what)}.${guess}`][variant % 3];
    case 'ghost':
      return [`${what}`, `${cap(what)}.`, `${cap(what)} pls fix`][variant % 3];
    default:
      return [
        `Hi! Since a little while ago ${what}. ${others}${note}${guess} Thanks for looking!`,
        `Hello, ${what} on my PC. ${others} I've already restarted once.${note}${guess}`,
        `Quick one: ${what}. ${others}${note}${guess} Let me know if you need me to try anything.`,
      ][variant % 3];
  }
}

/** What a helpful user notices on their own screen for desk-side faults. */
function deskNoteFor(atoms: Atom[]): string | null {
  if (atoms.some((a) => a.id === 'cable-out')) return 'Windows says "Network cable unplugged".';
  if (atoms.some((a) => a.id === 'nic-disabled' || a.id === 'nic-driver')) return 'The network icon has a red X on it.';
  if (atoms.some((a) => a.id === 'apipa' || a.id === 'helper-gone' || a.id === 'access-vlan' || a.id === 'access-port-trunk')) return 'It says "Unidentified network".';
  if (atoms.some((a) => a.id === 'print-driver')) return 'Printing gives error 0x0000011b.';
  return null;
}

// ---------------------------------------------------------------- the template

function priorityFor(lost: Record<string, string[]>): Priority {
  const users = Object.keys(lost).length;
  const all = Object.values(lost).flat();
  const onlyPrint = all.every((x) => x === 'print');
  if (users >= 5) return onlyPrint ? 3 : 1;
  if (users >= 2) return onlyPrint ? 3 : 2;
  return onlyPrint ? 4 : 3;
}

function buildGenerated(env: Env, params: Params): TicketDraft {
  const net = env.net;
  const atoms = (): Atom[] => JSON.parse(String(params.atoms));
  const lost = (): Record<string, string[]> => (params.lost ? JSON.parse(String(params.lost)) : {});
  const reporter = person(env, params.pcId);
  const faults = (): { f: Fault; site: Site }[] => atoms().map((a) => ({ f: faultById(a.id), site: a.site }));
  const victims = (): string[] => [...new Set(faults().flatMap(({ f, site }) => f.victims(net, env.office, site)).concat(reporter.pcId))];
  const actor = Number(params.actor) >= 0 ? ACTORS[Number(params.actor)] : null;
  const herring = Number(params.herring ?? -1);
  const diff = String(params.diff) as Difficulty;

  return {
    templateId: GENERATED_ID,
    params,
    kind: 'incident',
    difficulty: diff,
    get truePriority(): Priority {
      return priorityFor(lost());
    },
    get subject(): string {
      return subjectFor(lost()[reporter.pcId] ?? Object.values(lost())[0] ?? ['internet'], Object.keys(lost()).length);
    },
    get description(): string {
      return describe(reporter, lost()[reporter.pcId] ?? Object.values(lost())[0] ?? ['internet'], Object.keys(lost()).length, Number(params.variant ?? 0), herring, reporter.persona === 'helpful' ? deskNoteFor(atoms()) : null);
    },
    reporter,
    get pcs(): string[] {
      return victims();
    },
    inject: () => {
      const list = atoms();
      for (const a of list) {
        const f = faultById(a.id);
        f.inject(net, a.site);
        const dev = f.configOn?.(a.site);
        if (dev && actor) net.log(dev, `%SYS-5-CONFIG_I: Configured from console by ${actor.user} on vty0 (${actor.ip})`);
      }
      params.atoms = JSON.stringify(list); // sites now hold the original values for fix()
      net.commit();
      const vs = victims();
      const hurt: Record<string, string[]> = {};
      withAwake(net, vs, () => {
        for (const pc of vs) {
          const b = brokenServices(net, pc);
          if (b.length) hurt[pc] = b;
        }
      });
      // The reporter is always someone the fault hurts; if they're unaffected the ticket is about whoever is.
      params.lost = JSON.stringify(hurt);
    },
    check: () => {
      const l = lost();
      const pcs = Object.keys(l);
      return withAwake(net, pcs, () => pcs.every((pc) => !brokenServices(net, pc).some((x) => l[pc].includes(x))));
    },
    fix: () => {
      for (const { f, site } of [...faults()].reverse()) f.fix(net, site);
      net.commit();
      for (const pc of victims()) {
        const d = net.device(pc);
        if (d.hostNet?.dhcp && (d.hostNet.apipa || !d.hostNet.lease)) dhcpRequest(net, pc);
      }
    },
    get explain(): string {
      const parts = faults().map(({ f, site }) => f.explain(net, site));
      if (actor) parts.push(`The change log points at ${actor.who}: "Configured from console by ${actor.user}".`);
      if (herring >= 0) parts.push(`(${reporter.name.split(' ')[0]}'s guess, "${HERRINGS[herring]}", had nothing to do with it.)`);
      return parts.join(' ');
    },
    get hint(): string {
      return faults()[0].f.hint;
    },
  };
}

export const generatedTemplate: TicketTemplate = {
  id: GENERATED_ID,
  difficulty: 'moderate',
  // Never picked like a hand-built template: the queue asks planGenerated() directly.
  canStart: () => false,
  plan: () => ({}),
  build: buildGenerated,
};
