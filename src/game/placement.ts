// The placement shift: an optional test at the start of a new game. Five tickets, easy to expert, run like a Network
// Engineer's shift: up to three open at once, each with ten game minutes from when it arrives, no hints and no
// escalation. The score places you at Tier 1, Tier 2 or Network Engineer.

import type { Office } from '../content/office';
import type { Network } from '../sim/network';
import { Rng } from '../sim/rng';
import { BASE_POINTS, RANKS, speedMultiplier, type Difficulty } from './scoring';
import { rebuildDraft, TEMPLATES, type Params, type TicketDraft } from './templates';

/** Same test for everyone: a ramp from a desk fault to a broadcast storm. */
export const PLACEMENT_STEPS = ['wrong-vlan', 'helper-missing', 'duplex-mismatch', 'ospf-hello-mismatch', 'stp-loop'];
export const STEP_MS = 10 * 60_000;
/** Score bands (the maximum is about 1,100: every ticket solved instantly). */
export const PLACEMENT_BANDS = { tier2: 600, engineer: 900 };
/** As many tickets in play as a Network Engineer gets. */
export const PLACEMENT_IN_PLAY = RANKS[2].maxOpenTickets;
const ARRIVAL_MS = 2 * 60_000;
const REFILL_MS = 90_000;

export interface PlacementResult {
  index: number;
  templateId: string;
  difficulty: Difficulty;
  solved: boolean;
  ms: number;
  points: number;
}

export interface ActiveStep {
  index: number;
  startedAt: number;
  params: Params;
}

export interface PlacementState {
  /** Next ticket to open, and the earliest time it can arrive. */
  next: number;
  nextAt?: number;
  active: ActiveStep[];
  results: PlacementResult[];
  done: boolean;
  placedRank: number | null;
}

/** Older saves ran one ticket at a time. */
interface LegacyState {
  index: number;
  stepStartedAt: number;
  params: Params | null;
  results: Omit<PlacementResult, 'index'>[];
  done: boolean;
  placedRank: number | null;
}

export class Placement {
  state: PlacementState;
  private drafts = new Map<number, TicketDraft>();

  constructor(
    private readonly net: Network,
    private readonly office: Office,
    state?: PlacementState | LegacyState,
  ) {
    if (state && !('active' in state)) {
      const old = state;
      state = {
        next: old.params && !old.done ? old.index + 1 : old.index,
        active: old.params && !old.done ? [{ index: old.index, startedAt: old.stepStartedAt, params: old.params }] : [],
        results: old.results.map((r, i) => ({ ...r, index: i })),
        done: old.done,
        placedRank: old.placedRank,
      };
    }
    this.state = (state as PlacementState | undefined) ?? { next: 0, active: [], results: [], done: false, placedRank: null };
    for (const a of this.state.active) this.drafts.set(a.index, rebuildDraft({ net, office }, PLACEMENT_STEPS[a.index], a.params));
  }

  /** Tickets in play, oldest first. */
  get current(): { index: number; draft: TicketDraft; remainingMs: number }[] {
    if (this.state.done) return [];
    return this.state.active.map((a) => ({ index: a.index, draft: this.drafts.get(a.index)!, remainingMs: Math.max(0, a.startedAt + STEP_MS - this.net.time) }));
  }

  /** PCs involved in the tickets in play (kept awake). */
  get pcs(): string[] {
    return this.current.flatMap((c) => c.draft.pcs);
  }

  /**
   * Tickets trickle in like a real shift: one at the start, then one every 2 minutes while fewer than three are open;
   * a freed slot fills again after 90 seconds.
   */
  fill(): void {
    if (this.state.done || this.state.active.length >= PLACEMENT_IN_PLAY || this.state.next >= PLACEMENT_STEPS.length) return;
    if (this.net.time < (this.state.nextAt ?? 0)) return;
    this.open(this.state.next++);
    this.state.nextAt = this.net.time + ARRIVAL_MS;
  }

  private open(index: number): void {
    const id = PLACEMENT_STEPS[index];
    const template = TEMPLATES.find((t) => t.id === id)!;
    const busy = new Set<string>([this.office.tutorial.pcId, ...this.pcs]);
    const ctx = { net: this.net, office: this.office, rng: new Rng(`placement-${id}`), busyPcs: busy, activeTemplates: new Set<string>(), usedTemplates: new Set<string>() };
    const params = template.plan(ctx);
    const draft = template.build(ctx, params);
    // The people in the test are at their desks with their PCs on.
    for (const pc of draft.pcs) this.net.device(pc).powered = true;
    this.net.commit({ silent: true });
    draft.inject();
    this.drafts.set(index, draft);
    this.state.active.push({ index, startedAt: this.net.time, params: JSON.parse(JSON.stringify(params)) });
  }

  /** "Check my fix" on one ticket: scores it if the network says it's fixed. */
  check(index: number): boolean {
    const a = this.state.active.find((x) => x.index === index);
    const d = this.drafts.get(index);
    if (!a || !d || this.state.done || !d.check()) return false;
    const ms = this.net.time - a.startedAt;
    this.finish(index, true, ms, Math.round(BASE_POINTS[d.difficulty] * speedMultiplier(ms, STEP_MS)));
    return true;
  }

  /** Give up on a ticket (or its time ran out): a senior fixes it, no points. */
  skip(index: number): void {
    const a = this.state.active.find((x) => x.index === index);
    const d = this.drafts.get(index);
    if (!a || !d || this.state.done) return;
    d.fix();
    this.finish(index, false, this.net.time - a.startedAt, 0);
  }

  /** Called each tick: tickets out of time are skipped, new ones arrive. */
  update(): void {
    for (const c of this.current) if (c.remainingMs === 0) this.skip(c.index);
    this.fill();
  }

  private finish(index: number, solved: boolean, ms: number, points: number): void {
    const d = this.drafts.get(index)!;
    this.state.results.push({ index, templateId: d.templateId, difficulty: d.difficulty, solved, ms, points });
    this.state.results.sort((x, y) => x.index - y.index);
    this.state.active = this.state.active.filter((x) => x.index !== index);
    this.drafts.delete(index);
    if (this.state.results.length >= PLACEMENT_STEPS.length) {
      this.state.done = true;
      this.state.placedRank = placedRank(this.state.results);
      return;
    }
    this.state.nextAt = Math.max(this.state.nextAt ?? 0, this.net.time + REFILL_MS);
  }

  get score(): number {
    return this.state.results.reduce((s, r) => s + r.points, 0);
  }
}

export function placedRank(results: PlacementResult[]): number {
  const score = results.reduce((s, r) => s + r.points, 0);
  if (score >= PLACEMENT_BANDS.engineer) return 2;
  if (score >= PLACEMENT_BANDS.tier2) return 1;
  return 0;
}
