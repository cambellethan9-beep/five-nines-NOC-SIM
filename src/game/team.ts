// Your team. For now that's the intern (from Tier 2): they pick up new tickets that match your runbooks, in the order
// of the priority YOU set, type the runbook's commands (with typos, depending on skill), and resolve the ticket only
// if the network says it's fixed; otherwise they hand it back with a log. Each employee keeps their own shift score.
// An intern who scores 200+ in 5 shifts in a row becomes a Tier 1 NOC tech and earns you 1,000 points; one who
// doesn't within 15 shifts leaves. Training happens in real time and earns made-up NetSmart certificates.

import type { Rng } from '../sim/rng';
import type { Game } from './game';
import { commandsOf, matchRunbook, runRunbook, type RunbookSource } from './runbooks';

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
  { id: 'NSCP', name: 'NetSmart Certified Professional', level: 'hard', realMs: 240 * MIN, requires: 'NSCA', about: 'Routing protocols, troubleshooting methodology, change management.', typoMult: 0.5, speedMult: 0.7 },
];

export type EmployeeStatus =
  | { kind: 'idle' }
  | { kind: 'working'; ticketId: string; runbookId: string; runbookTitle: string; doneAt: number }
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
}

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
        t.runLog = log;
        e.typos += log.filter((l) => l.meant !== undefined).length;
        game.net.commit();
        if (t.draft.check()) {
          const pts = q.resolveByEmployee(t.id, e.name, `Fixed it by following your runbook "${rb.title}". (${log.length} commands, log attached.)`);
          e.shiftPoints[q.shift] = (e.shiftPoints[q.shift] ?? 0) + pts;
          e.lifetimePoints += pts;
          e.resolved++;
          this.say(now, `${e.name} resolved ${t.id} with "${rb.title}" (+${pts}).`);
        } else {
          t.assignedTo = undefined;
          e.handedBack++;
          t.activity.push({ t: now, who: 'senior', name: e.name, text: `Followed "${rb.title}" but it's still broken. Handing it back to you; the log of what I typed is attached.` });
          this.say(now, `${e.name} couldn't fix ${t.id} with "${rb.title}" and handed it back.`);
        }
        continue;
      }
      if (st.kind !== 'idle') continue;
      // Pick up the next unclaimed ticket a runbook matches, in the order of the priority YOU gave them.
      const books = this.runbooksFor(e, game);
      if (!books.length) continue;
      const waiting = q
        .openTickets()
        .filter((t) => (t.status === 'new' || t.status === 'reopened') && !t.assignedTo && !t.escalation && t.seniorAt === null)
        .sort((a, b) => a.priority - b.priority || a.openedAt - b.openedAt);
      for (const t of waiting) {
        const rb = matchRunbook(books, t);
        if (!rb) continue;
        this.assign(game, e, t.id, rb);
        break;
      }
    }
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
