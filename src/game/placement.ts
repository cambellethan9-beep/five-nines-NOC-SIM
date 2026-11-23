// The placement shift: an optional test at the start of a new game. It's an ordinary shift, the same mix of tickets
// and the same scoring as a Network Engineer's (up to three tickets in play), except there's no escalation and no
// hints. The shift score places you at Tier 1, Tier 2 or Network Engineer. Its points don't count toward your career.

/** Shift score needed for each starting rank. */
export const PLACEMENT_BANDS = { tier2: 600, engineer: 900 };
/** The shift runs with a Network Engineer's ticket mix and limits. */
export const PLACEMENT_RANK = 2;

export interface PlacementState {
  /** The placement shift is running. */
  active: boolean;
  /** It's over; `score` and `placedRank` are set. */
  done: boolean;
  /** The player has seen the results and started their first real shift. */
  acknowledged: boolean;
  score: number | null;
  placedRank: number | null;
  /** Lifetime points before the test (they're put back afterwards). */
  lifetimeBefore: number;
  /** Ticket counts for the results screen. */
  resolved?: number;
  opened?: number;
}

export function placedRank(score: number): number {
  if (score >= PLACEMENT_BANDS.engineer) return 2;
  if (score >= PLACEMENT_BANDS.tier2) return 1;
  return 0;
}

/** Saves from before the placement test was a normal shift held a different shape: treat them as finished. */
export function migratePlacement(s: unknown): PlacementState | null {
  if (!s || typeof s !== 'object') return null;
  if ('active' in s) return s as PlacementState;
  const old = s as { placedRank?: number | null };
  return { active: false, done: true, acknowledged: true, score: null, placedRank: old.placedRank ?? 0, lifetimeBefore: 0 };
}
