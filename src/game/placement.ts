// The placement shift: an optional test at the start of a new game. Five tickets, easy to expert, one at a time,
// ten game minutes each, no hints and no escalation. The score places you at Tier 1, Tier 2 or Network Engineer.

import type { Office } from '../content/office';
import type { Network } from '../sim/network';
import { Rng } from '../sim/rng';
import { BASE_POINTS, speedMultiplier, type Difficulty } from './scoring';
import { rebuildDraft, TEMPLATES, type Params, type TicketDraft } from './templates';

/** Same test for everyone: a ramp from a desk fault to a broadcast storm. */
export const PLACEMENT_STEPS = ['wrong-vlan', 'helper-missing', 'duplex-mismatch', 'ospf-hello-mismatch', 'stp-loop'];
export const STEP_MS = 10 * 60_000;
/** Score bands. Network Engineer also needs the hard or the expert ticket solved. */
export const PLACEMENT_BANDS = { tier2: 300, engineer: 650 };

export interface PlacementResult {
  templateId: string;
  difficulty: Difficulty;
  solved: boolean;
  ms: number;
  points: number;
}

export interface PlacementState {
  index: number;
  stepStartedAt: number;
  params: Params | null;
  results: PlacementResult[];
  done: boolean;
  placedRank: number | null;
}

export class Placement {
  state: PlacementState;
  private draft: TicketDraft | null = null;

  constructor(
    private readonly net: Network,
    private readonly office: Office,
    state?: PlacementState,
  ) {
    this.state = state ?? { index: 0, stepStartedAt: net.time, params: null, results: [], done: false, placedRank: null };
    if (state?.params && !state.done) this.draft = rebuildDraft({ net, office }, PLACEMENT_STEPS[state.index], state.params);
  }

  get current(): TicketDraft | null {
    return this.state.done ? null : this.draft;
  }

  get remainingMs(): number {
    return Math.max(0, this.state.stepStartedAt + STEP_MS - this.net.time);
  }

  /** Breaks the network for the current step. */
  startStep(): void {
    const id = PLACEMENT_STEPS[this.state.index];
    const template = TEMPLATES.find((t) => t.id === id)!;
    const ctx = { net: this.net, office: this.office, rng: new Rng(`placement-${id}`), busyPcs: new Set<string>([this.office.tutorial.pcId]), activeTemplates: new Set<string>(), usedTemplates: new Set<string>() };
    const params = template.plan(ctx);
    this.draft = template.build(ctx, params);
    this.state.params = JSON.parse(JSON.stringify(params));
    this.state.stepStartedAt = this.net.time;
    // The people in the test are at their desks with their PCs on.
    for (const pc of this.draft.pcs) this.net.device(pc).powered = true;
    this.net.commit({ silent: true });
    this.draft.inject();
  }

  /** "Check my fix": scores the step if the network says it's fixed. */
  check(): boolean {
    if (!this.draft || this.state.done) return false;
    if (!this.draft.check()) return false;
    const ms = this.net.time - this.state.stepStartedAt;
    const base = BASE_POINTS[this.draft.difficulty];
    this.finishStep(true, ms, Math.round(base * speedMultiplier(ms, STEP_MS)));
    return true;
  }

  /** Give up on this step (or time ran out): a senior fixes it, no points. */
  skip(): void {
    if (!this.draft || this.state.done) return;
    this.draft.fix();
    this.finishStep(false, this.net.time - this.state.stepStartedAt, 0);
  }

  /** Called each tick: time's up means the step is skipped. */
  update(): void {
    if (!this.state.done && this.draft && this.remainingMs === 0) this.skip();
  }

  private finishStep(solved: boolean, ms: number, points: number): void {
    const d = this.draft!;
    this.state.results.push({ templateId: d.templateId, difficulty: d.difficulty, solved, ms, points });
    this.state.index++;
    this.draft = null;
    this.state.params = null;
    if (this.state.index >= PLACEMENT_STEPS.length) {
      this.state.done = true;
      this.state.placedRank = placedRank(this.state.results);
      return;
    }
    this.startStep();
  }

  get score(): number {
    return this.state.results.reduce((s, r) => s + r.points, 0);
  }
}

export function placedRank(results: PlacementResult[]): number {
  const score = results.reduce((s, r) => s + r.points, 0);
  const bigOne = results.some((r) => r.solved && (r.difficulty === 'hard' || r.difficulty === 'expert'));
  if (score >= PLACEMENT_BANDS.engineer && bigOne) return 2;
  if (score >= PLACEMENT_BANDS.tier2) return 1;
  return 0;
}
