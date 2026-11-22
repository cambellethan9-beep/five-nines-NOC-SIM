// The real-time ticket queue: schedules faults and reports, runs SLA clocks, and handles
// acknowledgement, priority changes, notes, resolves, false resolves and senior takeovers.

import type { Office } from '../content/office';
import type { Network } from '../sim/network';
import type { Rng } from '../sim/rng';
import {
  falseResolvePenalty,
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
import { portShutdown, rebuildDraft, TEMPLATES, type Params, type TicketDraft, type TicketTemplate } from './templates';

export type TicketStatus = 'new' | 'in-progress' | 'resolved' | 'escalated' | 'reopened' | 'senior-resolved';

export interface Activity {
  t: number;
  who: 'system' | 'you' | 'user' | 'senior';
  text: string;
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
  score: ScoreLine[];
  activity: Activity[];
  /** Shift number the ticket was opened in. */
  shift: number;
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
        t.draft.fix();
        t.status = 'senior-resolved';
        t.resolvedAt = now;
        t.activity.push({ t: now, who: 'senior', text: 'Took this over and fixed it. Check the device config to see what was wrong.' });
      }
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
    const template = this.pickTemplate();
    if (!template) return;
    const ctx = this.context();
    const draft = template.build(ctx, template.plan(ctx));
    this.used.add(template.id);
    draft.inject();
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
    this.rankIndex = s.rankIndex;
    this.shift = s.shift;
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

  private context() {
    const active = new Set<string>();
    for (const p of this.pending) active.add(p.draft.templateId);
    for (const t of this.openTickets()) active.add(t.draft.templateId);
    return { net: this.net, office: this.office, rng: this.rng, busyPcs: this.busyPcs(), activeTemplates: active, usedTemplates: this.used };
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
    };
    if (draft.kind === 'request') t.id = t.id.replace('INC', 'CHG');
    this.tickets.unshift(t);
    return t;
  }

  find(id: string): Ticket {
    const t = this.tickets.find((x) => x.id === id);
    if (!t) throw new Error(`No ticket ${id}`);
    return t;
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

  /** Resolve button. Verifies the outcome before closing. */
  resolve(id: string, note: string): ResolveResult {
    const t = this.find(id);
    const now = this.net.time;
    if (!this.isOpen(t)) return { ok: false, message: 'This ticket is already closed.', lines: [] };
    this.respond(t);
    if (note.trim()) t.activity.push({ t: now, who: 'you', text: note.trim() });

    if (t.draft.check()) {
      let lines = resolveScore(this.scoreInput(t));
      if (t.falseResolves > 0) {
        // Coming back to it later still pays, just not as much as getting it right first.
        const share = RULES.revisitShare;
        lines = lines.map((l) => ({ label: l.label, points: l.points > 0 ? Math.round(l.points * share) : l.points }));
        lines.unshift({ label: `Resolved on a second attempt (×${share})`, points: 0 });
        const recovered = Math.round(t.penaltyTaken * RULES.revisitRecovery);
        if (recovered > 0) lines.push({ label: 'Recovered part of the false-resolve penalty', points: recovered });
      }
      t.status = 'resolved';
      t.resolvedAt = now;
      t.activity.push({ t: now, who: 'system', text: 'Verified: the user is working again. Ticket resolved.' });
      this.award(t, lines);
      return { ok: true, message: `${t.id} resolved. ${total(lines) >= 0 ? '+' : ''}${total(lines)} points.`, lines };
    }

    // Not actually fixed.
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
        text: `Reopened: the problem isn't fixed. A senior tech will take this over in ${RULES.seniorTakeoverMs / MIN} minutes. Fix it before then for partial credit.`,
      });
      return { ok: false, message: `Not fixed. ${t.id} was escalated to a senior. No points.`, lines: [] };
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
