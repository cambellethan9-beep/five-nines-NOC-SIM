// The real-time ticket queue: schedules faults and reports, runs SLA clocks, and handles
// acknowledgement, priority changes, notes, resolves, false resolves and senior takeovers.

import type { Office } from '../content/office';
import type { Network } from '../sim/network';
import type { Rng } from '../sim/rng';
import {
  falseResolvePenalty,
  isMenial,
  RANKS,
  resolveScore,
  RULES,
  SLA,
  total,
  type Difficulty,
  type Priority,
  type Rank,
  type ScoreLine,
} from './scoring';
import { BASE_POINTS } from './scoring';
import { GENERATED_SHARE, generatedTemplate, planGenerated } from './generator';
import type { RunLogEntry } from './runbooks';
import { canEscalateTo, coworker, COWORKERS, isDelegation, wastesManagersTime, type CoworkerId } from './coworkers';
import { portShutdown, rebuildDraft, TEMPLATES, type Params, type TicketDraft, type TicketTemplate } from './templates';

export type TicketStatus = 'new' | 'in-progress' | 'resolved' | 'escalated' | 'reopened' | 'senior-resolved';

export interface Activity {
  t: number;
  who: 'system' | 'you' | 'user' | 'senior';
  text: string;
  /** Display name for 'senior' entries (the coworker who wrote it). */
  name?: string;
}

export interface Escalation {
  to: CoworkerId;
  at: number;
  /** When they finish (and either fix it or hand it back). */
  doneAt: number;
  /** Decided when you escalate, so saves replay exactly. */
  success: boolean;
  /** Handed down to your own team (NOC Supervisor and up) rather than escalated. */
  delegated?: boolean;
}

export interface Ticket {
  id: string;
  draft: TicketDraft;
  difficulty: Difficulty;
  truePriority: Priority;
  /** The priority shown in the queue. Starts as the service desk's call; you can change it. */
  priority: Priority;
  status: TicketStatus;
  faultAt: number;
  openedAt: number;
  respondedAt: number | null;
  resolvedAt: number | null;
  breached: boolean;
  respondMissed: boolean;
  proactive: boolean;
  falseResolves: number;
  /** Lifetime points lost to false resolves on this ticket (can be partly recovered). */
  penaltyTaken: number;
  seniorAt: number | null;
  /** Handed to a coworker. */
  escalation?: Escalation | null;
  /** Who fixed it, when it wasn't you. */
  resolvedBy?: CoworkerId;
  score: ScoreLine[];
  activity: Activity[];
  /** Shift number the ticket was opened in. */
  shift: number;
  /**
   * When the user was told it's working again. null = fixed but nobody told them yet (they're still sitting idle);
   * undefined = nothing to tell (requests, tickets from older saves).
   */
  notifiedAt?: number | null;
  /** Employee working it (team.ts), and the runbook they're following. */
  assignedTo?: string;
  runbook?: string;
  /** What the employee typed and what the devices answered, last attempt. */
  runLog?: RunLogEntry[];
  /** Employee who resolved it. */
  employee?: string;
}

interface Pending {
  draft: TicketDraft;
  faultAt: number;
  reportAt: number;
  nextCheck: number;
}

type DraftRef = { templateId: string; params: Params };

export interface QueueState {
  tickets: (Omit<Ticket, 'draft'> & { draft: DraftRef })[];
  pending: (Omit<Pending, 'draft'> & { draft: DraftRef })[];
  seq: number;
  nextTicketAt: number;
  waitingForSlot?: boolean;
  used: string[];
  events: ScoreEvent[];
  lifetimePoints: number;
  rankIndex: number;
  shift: number;
  /** Shifts in a row that met the uptime target. */
  streak?: number;
  /** Shifts in a row that reached the promotion threshold for the current rank. */
  qualifyingShifts?: number;
}

export interface ScoreEvent {
  t: number;
  label: string;
  points: number;
  ticketId?: string;
}

export interface ResolveResult {
  ok: boolean;
  message: string;
  lines: ScoreLine[];
}

const MIN = 60_000;

export class TicketQueue {
  readonly tickets: Ticket[] = [];
  private readonly pending: Pending[] = [];
  private seq = 1001;
  private nextTicketAt: number;
  private readonly used = new Set<string>();
  /** Generation is paused because the rank's ticket limit is reached. */
  private waitingForSlot = false;
  readonly events: ScoreEvent[] = [];
  /** Net points across all shifts; false-resolve penalties are a share of this. */
  lifetimePoints = 0;
  rankIndex = 0;
  shift = 1;
  streak = 0;
  qualifyingShifts = 0;

  constructor(
    private readonly net: Network,
    private readonly office: Office,
    private readonly rng: Rng,
    /** Generation stops near the end of a shift. */
    private readonly shiftEndsAt: () => number,
  ) {
    this.nextTicketAt = net.time + rng.int(3 * MIN, 6 * MIN);
  }

  get rank(): Rank {
    return RANKS[this.rankIndex];
  }

  /** The tutorial: the office was built with Priya's port already shut. */
  openTutorial(): Ticket {
    const t = this.office.tutorial;
    const draft = portShutdown.build({ net: this.net, office: this.office }, { pcId: t.person.pcId, variant: 0, alreadyBroken: true });
    this.used.add(draft.templateId);
    return this.open(draft, this.net.time, 3);
  }

  /** PCs that must not fall asleep (involved in an open or pending ticket). */
  busyPcs(): Set<string> {
    const set = new Set<string>();
    for (const p of this.pending) p.draft.pcs.forEach((id) => set.add(id));
    for (const t of this.tickets) if (this.isOpen(t)) t.draft.pcs.forEach((id) => set.add(id));
    return set;
  }

  isOpen(t: Ticket): boolean {
    return t.status === 'new' || t.status === 'in-progress' || t.status === 'escalated' || t.status === 'reopened';
  }

  openTickets(): Ticket[] {
    return this.tickets.filter((t) => this.isOpen(t));
  }

  /** Called every tick. */
  update(): void {
    const now = this.net.time;
    this.maybeGenerate(now);

    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (now >= p.nextCheck && p.draft.kind === 'incident') {
        p.nextCheck = now + 15_000;
        if (p.draft.check()) {
          // Fixed before anyone noticed: credit it as caught early.
          this.pending.splice(i, 1);
          const t = this.open(p.draft, p.faultAt, p.draft.truePriority);
          t.status = 'resolved';
          t.proactive = true;
          t.resolvedAt = now;
          t.notifiedAt = now;
          t.respondedAt = now;
          t.activity.push({ t: now, who: 'system', text: 'Fixed before the user reported it. Ticket logged for the record.' });
          this.award(t, resolveScore({ ...this.scoreInput(t), proactive: true }));
          continue;
        }
      }
      if (now >= p.reportAt) {
        this.pending.splice(i, 1);
        this.open(p.draft, p.faultAt, this.deskPriority(p.draft.truePriority));
      }
    }

    for (const t of this.tickets) {
      if (!this.isOpen(t)) continue;
      const sla = SLA[t.truePriority];
      if (!t.respondMissed && t.respondedAt === null && now - t.openedAt > sla.respondMs) {
        t.respondMissed = true;
        t.activity.push({ t: now, who: 'system', text: 'Response SLA missed.' });
      }
      if (!t.breached && now - t.openedAt > sla.resolveMs) {
        t.breached = true;
        t.activity.push({ t: now, who: 'system', text: `Resolve SLA breached. This ticket's real impact is P${t.truePriority} (${sla.name}).` });
      }
      if (t.status === 'escalated' && t.seniorAt !== null && now >= t.seniorAt) {
        // After a false resolve at Tier 1, Owen takes it over. No points for you.
        if (!this.seniorFix(t)) {
          t.seniorAt = now + 10 * MIN;
          const text = "Fixed what I could find, but people on this ticket are still down, so there's something else going on. Still on it.";
          t.activity.push({ t: now, who: 'senior', name: 'Owen Price', text });
          continue;
        }
        t.status = 'senior-resolved';
        t.resolvedAt = now;
        t.resolvedBy = 'owen';
        t.notifiedAt = now;
        const text = `Took this over and fixed it. ${t.draft.explain}`;
        t.activity.push({ t: now, who: 'senior', name: 'Owen Price', text });
        this.onCoworkerMessage?.('owen', `About ${t.id}: ${t.draft.explain}`);
      }
      if (t.status === 'escalated' && t.escalation && now >= t.escalation.doneAt) this.finishEscalation(t);
    }
  }

  /** Tickets in play: open, or already broken but not reported yet. */
  inPlay(): number {
    return this.openTickets().length + this.pending.length;
  }

  private maybeGenerate(now: number): void {
    // At the rank's limit: wait. When a slot frees up, give the player a breather first.
    if (this.inPlay() >= this.rank.maxOpenTickets) {
      this.waitingForSlot = true;
      return;
    }
    if (this.waitingForSlot) {
      this.waitingForSlot = false;
      this.nextTicketAt = Math.max(this.nextTicketAt, now + this.rng.int(90_000, 4 * MIN));
    }
    if (now < this.nextTicketAt) return;
    this.nextTicketAt = now + this.rng.int(4 * MIN, 9 * MIN);
    if (now > this.shiftEndsAt() - 8 * MIN) return;
    const next = this.pickNext();
    if (!next) return;
    const draft = next.template.build(this.context(), next.params);
    this.used.add(next.template.id);
    draft.inject();
    // A generated fault that turned out to hurt nobody (everyone affected was away, say): quietly undo it.
    if (next.template === generatedTemplate && draft.check()) {
      draft.fix();
      return;
    }
    // Office-wide outages get noticed fast; one person's problem takes longer to be reported.
    const delay = draft.kind === 'request' ? 0 : draft.truePriority <= 2 ? this.rng.int(30_000, 90_000) : this.rng.int(60_000, 240_000);
    this.pending.push({ draft, faultAt: now, reportAt: now + delay, nextCheck: now + 15_000 });
  }

  /** Plain-JSON state for saved games. Drafts are stored as template id + params and rebuilt on load. */
  exportState(): QueueState {
    const draftRef = (d: TicketDraft) => ({ templateId: d.templateId, params: d.params });
    return {
      tickets: this.tickets.map((t) => ({ ...t, draft: draftRef(t.draft) })),
      pending: this.pending.map((p) => ({ ...p, draft: draftRef(p.draft) })),
      seq: this.seq,
      nextTicketAt: this.nextTicketAt,
      waitingForSlot: this.waitingForSlot,
      used: [...this.used],
      events: this.events.slice(-500),
      lifetimePoints: this.lifetimePoints,
      rankIndex: this.rankIndex,
      shift: this.shift,
      streak: this.streak,
      qualifyingShifts: this.qualifyingShifts,
    };
  }

  importState(s: QueueState): void {
    const env = { net: this.net, office: this.office };
    const build = (d: { templateId: string; params: Params }) => rebuildDraft(env, d.templateId, d.params);
    this.tickets.splice(0, this.tickets.length, ...s.tickets.map((t) => ({ ...t, draft: build(t.draft) })));
    this.pending.splice(0, this.pending.length, ...s.pending.map((p) => ({ ...p, draft: build(p.draft) })));
    this.seq = s.seq;
    this.nextTicketAt = s.nextTicketAt;
    this.waitingForSlot = s.waitingForSlot ?? false;
    this.used.clear();
    s.used.forEach((u) => this.used.add(u));
    this.events.splice(0, this.events.length, ...s.events);
    this.lifetimePoints = s.lifetimePoints;
    this.rankIndex = Math.min(s.rankIndex, RANKS.length - 1);
    this.shift = s.shift;
    this.streak = s.streak ?? 0;
    this.qualifyingShifts = s.qualifyingShifts ?? 0;
  }

  /** Called when a shift starts: the next new ticket arrives a few minutes in. */
  scheduleFromNow(): void {
    this.nextTicketAt = this.net.time + this.rng.int(3 * MIN, 6 * MIN);
  }

  /** Starts a specific ticket type now (tests and debugging). Returns false if it can't start. */
  startTemplate(templateId: string, reportDelayMs = 60_000): boolean {
    const template = TEMPLATES.find((t) => t.id === templateId);
    if (!template || !template.canStart(this.context())) return false;
    const ctx = this.context();
    const draft = template.build(ctx, template.plan(ctx));
    this.used.add(template.id);
    draft.inject();
    const now = this.net.time;
    this.pending.push({ draft, faultAt: now, reportAt: now + reportDelayMs, nextCheck: now + 15_000 });
    return true;
  }

  /**
   * Breaks something that wore out (breakage.ts) with a plan from planHardware. It ignores the rank's ticket limit:
   * hardware doesn't wait for you to be free. Returns false if it turned out to hurt nobody (then nothing changes).
   */
  startGenerated(params: Params, reportDelayMs: number): boolean {
    const draft = generatedTemplate.build(this.context(), params);
    draft.inject();
    if (draft.check()) {
      draft.fix();
      return false;
    }
    const now = this.net.time;
    this.pending.push({ draft, faultAt: now, reportAt: now + reportDelayMs, nextCheck: now + 15_000 });
    return true;
  }

  context() {
    const active = new Set<string>();
    for (const p of this.pending) active.add(p.draft.templateId);
    for (const t of this.openTickets()) active.add(t.draft.templateId);
    return { net: this.net, office: this.office, rng: this.rng, busyPcs: this.busyPcs(), activeTemplates: active, usedTemplates: this.used };
  }

  /** The next new problem: usually from the fault generator, otherwise a hand-built ticket. */
  pickNext(): { template: TicketTemplate; params: Params } | null {
    const ctx = this.context();
    if (this.rng.chance(GENERATED_SHARE)) {
      const order: Difficulty[] = ['trivial', 'easy', 'moderate', 'hard', 'expert'];
      const weights = this.rank.difficultyWeights;
      const wanted = this.rng.weighted(order.map((d) => ({ item: d, weight: weights[d] })));
      const params = planGenerated(ctx, wanted, this.rankIndex);
      if (params) return { template: generatedTemplate, params };
    }
    const template = this.pickTemplate();
    return template ? { template, params: template.plan(this.context()) } : null;
  }

  /** Picks a difficulty using the rank's weights, then an eligible template of that difficulty. */
  pickTemplate(): TicketTemplate | null {
    const ctx = this.context();
    const order: Difficulty[] = ['trivial', 'easy', 'moderate', 'hard', 'expert'];
    const weights = this.rank.difficultyWeights;
    const wanted = this.rng.weighted(order.map((d) => ({ item: d, weight: weights[d] })));
    // Try the wanted difficulty first, then the nearest ones.
    const byDistance = [...order].sort((a, b) => Math.abs(order.indexOf(a) - order.indexOf(wanted)) - Math.abs(order.indexOf(b) - order.indexOf(wanted)));
    for (const d of byDistance) {
      const eligible = TEMPLATES.filter((t) => t.difficulty === d && t.canStart(ctx));
      if (eligible.length) return this.rng.pick(eligible);
    }
    return null;
  }

  /** The service desk usually gets priority right, but not always. */
  private deskPriority(truth: Priority): Priority {
    if (this.rng.chance(0.75)) return truth;
    // Users exaggerate more often than they downplay.
    const shift = this.rng.chance(0.65) ? -1 : 1;
    return Math.min(4, Math.max(1, truth + shift)) as Priority;
  }

  private open(draft: TicketDraft, faultAt: number, priority: Priority): Ticket {
    const now = this.net.time;
    const t: Ticket = {
      id: `INC-${this.seq++}`,
      draft,
      difficulty: draft.difficulty,
      truePriority: draft.truePriority,
      priority,
      status: 'new',
      faultAt,
      openedAt: now,
      respondedAt: null,
      resolvedAt: null,
      breached: false,
      respondMissed: false,
      proactive: false,
      falseResolves: 0,
      penaltyTaken: 0,
      seniorAt: null,
      score: [],
      activity: [
        { t: now, who: 'user', text: draft.description },
        { t: now, who: 'system', text: `Opened by the service desk as P${priority} (${SLA[priority].name}).` },
      ],
      shift: this.shift,
      ...(draft.kind === 'incident' ? { notifiedAt: null } : {}),
    };
    if (draft.kind === 'request') t.id = t.id.replace('INC', 'CHG');
    this.tickets.unshift(t);
    this.onOpened?.(t, faultAt);
    return t;
  }

  find(id: string): Ticket {
    const t = this.tickets.find((x) => x.id === id);
    if (!t) throw new Error(`No ticket ${id}`);
    return t;
  }

  /** Hooks from the game: a senior's tidy-up after a fix, and how many people are still affected by anything. */
  onSeniorCleanup?: () => void;
  affectedNow?: () => number;
  /** Extra points for fixing a ticket in a topic you're weak at (set by the game from your skill radar). */
  growthBonus?: (t: Ticket) => ScoreLine | null;

  /** A coworker applies the fix, tidies up like a senior would, then checks it really worked. */
  private seniorFix(t: Ticket): boolean {
    t.draft.fix();
    this.onSeniorCleanup?.();
    return t.draft.check();
  }

  /** A senior fixes and closes everything open or still unreported (no points either way). */
  closeAllBySenior(text: string): void {
    const now = this.net.time;
    for (const p of this.pending.splice(0)) p.draft.fix();
    for (const t of this.openTickets()) {
      t.draft.fix();
      t.status = 'senior-resolved';
      t.resolvedBy = 'owen';
      t.resolvedAt = now;
      t.notifiedAt = now;
      t.escalation = null;
      t.activity.push({ t: now, who: 'senior', name: 'Owen Price', text });
    }
    // The fixed users were told; nobody is left waiting.
    for (const t of this.awaitingNotice()) t.notifiedAt = now;
  }

  /** Fixed tickets whose user hasn't been told yet: they're still sitting there not working. */
  awaitingNotice(): Ticket[] {
    return this.tickets.filter((t) => t.status === 'resolved' && t.notifiedAt === null);
  }

  /** Tell the user it's working again (a direct message, or an announcement to everyone). */
  notify(id: string, how: 'direct' | 'everyone'): string | null {
    const t = this.find(id);
    if (t.notifiedAt !== null) return 'Nothing to tell: the user already knows, or this ticket has no one waiting.';
    if (t.status !== 'resolved') return 'Resolve the ticket first.';
    t.notifiedAt = this.net.time;
    t.activity.push({ t: this.net.time, who: 'you', text: how === 'direct' ? `Let ${t.draft.reporter.name} know it's working again.` : "Announced to everyone that it's working again." });
    return null;
  }

  /** At the end of a shift, anyone still waiting finds out the next morning. */
  settleNotices(): void {
    for (const t of this.awaitingNotice()) {
      t.notifiedAt = this.net.time;
      t.activity.push({ t: this.net.time, who: 'system', text: `${t.draft.reporter.name} found out it was fixed the next morning. Nobody told them.` });
    }
  }

  /** Notified when a ticket opens (the game links it to a declared incident). */
  onOpened?: (t: Ticket, faultAt: number) => void;

  /** Notified when a coworker has something to tell you (wired to chat by the game). */
  onCoworkerMessage?: (id: CoworkerId, text: string) => void;

  /** Is this coworker already working one of your tickets? */
  coworkerBusy(id: CoworkerId): boolean {
    return this.tickets.some((t) => this.isOpen(t) && t.escalation?.to === id);
  }

  /** Why you can't escalate this ticket to this coworker right now, or null if you can. */
  escalationBlocked(t: Ticket, id: CoworkerId): string | null {
    const c = coworker(id);
    if (!this.isOpen(t)) return 'This ticket is closed.';
    if (t.assignedTo) return `${t.assignedTo} is working on it.`;
    if (t.escalation) return `Already with ${coworker(t.escalation.to).name.split(' ')[0]}.`;
    if (t.seniorAt !== null) return 'Owen is already taking this over.';
    if (!canEscalateTo(c, this.rankIndex)) return `${c.name.split(' ')[0]} doesn't outrank you, and doesn't work for you.`;
    if (this.coworkerBusy(id)) return `${c.name.split(' ')[0]} is busy with another of your tickets.`;
    return null;
  }

  /** Coworkers you could escalate to at your rank (busy or not). */
  escalationTargets() {
    return COWORKERS.filter((c) => canEscalateTo(c, this.rankIndex));
  }

  escalate(id: string, to: CoworkerId): string {
    const t = this.find(id);
    const blocked = this.escalationBlocked(t, to);
    if (blocked) return blocked;
    const c = coworker(to);
    const now = this.net.time;
    this.respond(t);
    t.escalation = {
      to,
      at: now,
      doneAt: now + this.rng.int(c.minMs, c.maxMs),
      success: this.rng.chance(c.success[t.difficulty]),
    };
    t.status = 'escalated';
    const down = isDelegation(c, this.rankIndex);
    t.escalation.delegated = down;
    t.activity.push({ t: now, who: 'you', text: `${down ? 'Assigned' : 'Escalated'} to ${c.name} (${c.title}).` });
    t.activity.push({ t: now, who: 'senior', name: c.name, text: c.id === 'gloria' ? "Got it. I'll take a look." : "On it. I'll let you know." });
    return `${t.id} ${down ? 'assigned' : 'escalated'} to ${c.name}.`;
  }

  private finishEscalation(t: Ticket): void {
    const esc = t.escalation!;
    const c = coworker(esc.to);
    const now = this.net.time;
    const first = c.name.split(' ')[0];
    if (!esc.success) {
      t.escalation = null;
      t.status = 'in-progress';
      const text = "Couldn't figure this one out, sorry. Handing it back. Maybe try Owen?";
      t.activity.push({ t: now, who: 'senior', name: c.name, text });
      this.onCoworkerMessage?.(c.id, `${t.id}: ${text}`);
      return;
    }
    if (!this.seniorFix(t)) {
      // They fixed what they found, but the people on this ticket are still down: be honest and hand it back.
      t.status = 'in-progress';
      t.escalation = null;
      const text = `I fixed what I found: ${t.draft.explain} But people on this ticket are still having problems, so something else is going on. Handing it back to you.`;
      t.activity.push({ t: now, who: 'senior', name: c.name, text });
      this.onCoworkerMessage?.(c.id, `${t.id}: ${text}`);
      return;
    }
    t.status = 'senior-resolved';
    t.resolvedAt = now;
    t.resolvedBy = c.id;
    const stillDown = this.affectedNow?.() ?? 0;
    const elsewhere = stillDown > 0 ? ` Heads up: ${stillDown} ${stillDown === 1 ? 'person is' : 'people are'} still having problems, but that's something else, not this ticket.` : '';
    t.activity.push({ t: now, who: 'senior', name: c.name, text: `Fixed and checked. ${t.draft.explain}${elsewhere}` });
    if (elsewhere) this.onCoworkerMessage?.(c.id, `${t.id} is fixed.${elsewhere}`);
    if (t.draft.kind === 'incident') {
      t.notifiedAt = now;
      t.activity.push({ t: now, who: 'senior', name: c.name, text: `Let ${t.draft.reporter.name} know it's working again.` });
    }
    const base = BASE_POINTS[t.difficulty];
    const credit = esc.delegated ? 1 : c.credit;
    const lines: ScoreLine[] = [
      esc.delegated
        ? { label: `Delegated to ${first}`, points: Math.round(base * credit) }
        : { label: `Escalated to ${first} (${Math.round(credit * 100)}% credit)`, points: Math.round(base * credit) },
    ];
    if (t.breached) lines.push({ label: 'Resolve SLA breached', points: -Math.round(base * RULES.breachPenalty) });
    if (t.respondMissed) lines.push({ label: 'Response SLA missed', points: -Math.round(base * RULES.missedResponsePenalty) });
    if (wastesManagersTime(c, t.difficulty, t.truePriority)) {
      lines.push({ label: "Sent the manager a routine ticket", points: -Math.round(base * RULES.managerTimePenalty) });
    }
    this.award(t, lines);
    let msg = `${t.id} is fixed. ${t.draft.explain}`;
    if (wastesManagersTime(c, t.difficulty, t.truePriority)) msg += ' Next time, try Owen first. I need to stay free for the big ones.';
    else if (c.id === 'owen' && !esc.delegated) msg += ' Write that one down, you\'ll see it again.';
    this.onCoworkerMessage?.(c.id, msg);
  }

  private respond(t: Ticket): void {
    if (t.respondedAt === null) t.respondedAt = this.net.time;
    if (t.status === 'new') t.status = 'in-progress';
  }

  acknowledge(id: string): void {
    const t = this.find(id);
    if (t.respondedAt !== null) return;
    this.respond(t);
    t.activity.push({ t: this.net.time, who: 'you', text: 'Acknowledged. Looking into it.' });
  }

  setPriority(id: string, p: Priority): void {
    const t = this.find(id);
    if (t.priority === p) return;
    t.activity.push({ t: this.net.time, who: 'you', text: `Changed priority P${t.priority} → P${p}.` });
    t.priority = p;
    this.respond(t);
  }

  addNote(id: string, text: string): void {
    const t = this.find(id);
    if (!text.trim()) return;
    t.activity.push({ t: this.net.time, who: 'you', text: text.trim() });
    this.respond(t);
  }

  private scoreInput(t: Ticket) {
    return {
      difficulty: t.difficulty,
      truePriority: t.truePriority,
      shownPriority: t.priority,
      elapsedMs: this.net.time - t.openedAt,
      respondedAfterMs: t.respondedAt === null ? null : t.respondedAt - t.openedAt,
      proactive: false,
    };
  }

  /**
   * An employee resolves a ticket after their runbook worked. Scored like your own fix (speed, SLA, triage) but
   * without the senior-rank penalty for routine work: that's the point of having staff. Returns the points.
   */
  resolveByEmployee(id: string, name: string, note: string): number {
    const t = this.find(id);
    const now = this.net.time;
    if (!this.isOpen(t)) return 0;
    this.respond(t);
    t.activity.push({ t: now, who: 'senior', name, text: note });
    const lines = resolveScore(this.scoreInput(t)).map((l) => ({ ...l, label: `${name}: ${l.label}` }));
    t.status = 'resolved';
    t.resolvedAt = now;
    t.employee = name;
    t.assignedTo = undefined;
    if (t.draft.kind === 'incident') {
      t.notifiedAt = now;
      t.activity.push({ t: now, who: 'senior', name, text: `Let ${t.draft.reporter.name} know it's working again.` });
    }
    this.award(t, lines);
    return total(lines);
  }

  /** Resolve button. Verifies the outcome before closing. */
  resolve(id: string, note: string): ResolveResult {
    const t = this.find(id);
    const now = this.net.time;
    if (!this.isOpen(t)) return { ok: false, message: 'This ticket is already closed.', lines: [] };
    this.respond(t);
    if (note.trim()) t.activity.push({ t: now, who: 'you', text: note.trim() });

    if (t.draft.check()) {
      if (t.escalation) {
        const who = coworker(t.escalation.to).name.split(' ')[0];
        t.activity.push({ t: now, who: 'system', text: `You fixed it before ${who} got to it. Escalation cancelled.` });
        t.escalation = null;
      }
      let lines = resolveScore(this.scoreInput(t));
      if (t.falseResolves > 0) {
        // Coming back to it later still pays, just not as much as getting it right first.
        const share = RULES.revisitShare;
        lines = lines.map((l) => ({ label: l.label, points: l.points > 0 ? Math.round(l.points * share) : l.points }));
        lines.unshift({ label: `Resolved on a second attempt (×${share})`, points: 0 });
        const recovered = Math.round(t.penaltyTaken * RULES.revisitRecovery);
        if (recovered > 0) lines.push({ label: 'Recovered part of the false-resolve penalty', points: recovered });
      }
      const menial = this.rank.menialPenaltyPct;
      if (menial > 0 && isMenial(t.difficulty)) {
        // At senior ranks, routine tickets belong to your team. Doing one yourself earns nothing and costs a little,
        // so you always end up lower than before. (Penalties already on the ticket, like a breach, still apply.)
        lines = [
          { label: `No credit: routine ticket done by hand (${this.rank.name})`, points: 0 },
          // Keep penalties, and the partial refund of an earlier false-resolve penalty.
          ...lines.filter((l) => l.points < 0 || l.label.startsWith('Recovered')),
          { label: 'Time a senior should have spent elsewhere', points: -Math.round(BASE_POINTS[t.difficulty] * menial) },
        ];
      } else if (t.falseResolves === 0) {
        const growth = this.growthBonus?.(t);
        if (growth) lines.push(growth);
      }
      t.status = 'resolved';
      t.resolvedAt = now;
      t.activity.push({ t: now, who: 'system', text: 'Verified: the user is working again. Ticket resolved.' });
      this.award(t, lines);
      return { ok: true, message: `${t.id} resolved. ${total(lines) >= 0 ? '+' : ''}${total(lines)} points.`, lines };
    }

    // Not actually fixed.
    if (t.escalation) return { ok: false, message: `Not fixed yet, and ${coworker(t.escalation.to).name.split(' ')[0]} is still working on it.`, lines: [] };
    t.falseResolves++;
    const rank = this.rank;
    if (rank.falseResolvePct === 0) {
      t.status = 'escalated';
      t.seniorAt = now + RULES.seniorTakeoverMs;
      t.activity.push({
        t: now,
        who: 'user',
        text: "It's still not working on my end.",
      });
      t.activity.push({
        t: now,
        who: 'system',
        text: `Reopened: the problem isn't fixed. Owen Price (Tier 2) will take this over in ${RULES.seniorTakeoverMs / MIN} minutes. Fix it before then for partial credit.`,
      });
      return { ok: false, message: `Not fixed. Owen will take ${t.id} over. No points.`, lines: [] };
    }
    const penalty = falseResolvePenalty(rank, this.lifetimePoints);
    t.penaltyTaken += penalty;
    t.status = 'reopened';
    t.activity.push({ t: now, who: 'user', text: "It's still not working on my end." });
    t.activity.push({ t: now, who: 'system', text: `Reopened: the problem isn't fixed. Penalty: ${penalty} points (${rank.falseResolvePct * 100}% of lifetime points).` });
    const lines = [{ label: 'False resolve', points: -penalty }];
    this.award(t, lines);
    return { ok: false, message: `Not fixed. ${t.id} reopened, −${penalty} points.`, lines };
  }

  private award(t: Ticket, lines: ScoreLine[]): void {
    t.score.push(...lines);
    for (const l of lines) {
      if (l.points === 0) continue;
      this.events.push({ t: this.net.time, label: `${t.id}: ${l.label}`, points: l.points, ticketId: t.id });
      this.lifetimePoints += l.points;
    }
  }

  /** Records non-ticket points (uptime drain, shift bonus). */
  addPoints(label: string, points: number): void {
    if (points === 0) return;
    this.events.push({ t: this.net.time, label, points });
    this.lifetimePoints += points;
  }

  /** Time left on the resolve clock, measured against the priority shown on the ticket. */
  dueIn(t: Ticket): number {
    return t.openedAt + SLA[t.priority].resolveMs - this.net.time;
  }
}
