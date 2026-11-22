// Scoring rules. Pure functions so the numbers are easy to test and tune.

export type Priority = 1 | 2 | 3 | 4;
export type Difficulty = 'trivial' | 'easy' | 'moderate' | 'hard' | 'expert';

const MIN = 60_000;

export const SLA: Record<Priority, { name: string; respondMs: number; resolveMs: number }> = {
  1: { name: 'Critical', respondMs: 2 * MIN, resolveMs: 15 * MIN },
  2: { name: 'High', respondMs: 5 * MIN, resolveMs: 30 * MIN },
  3: { name: 'Medium', respondMs: 10 * MIN, resolveMs: 60 * MIN },
  4: { name: 'Low', respondMs: 20 * MIN, resolveMs: 120 * MIN },
};

/** Points for a ticket resolved right at its deadline. An hour-long build is worth about 300. */
export const BASE_POINTS: Record<Difficulty, number> = {
  trivial: 40,
  easy: 80,
  moderate: 140,
  hard: 220,
  expert: 300,
};

export interface Rank {
  name: string;
  /** Service availability target for a shift. */
  uptimeTarget: number;
  /** Share of tickets that must be resolved within SLA. */
  slaTarget: number;
  /** How many tickets can be in play at once (open, or broken but not yet reported). */
  maxOpenTickets: number;
  /** Share of lifetime points lost on a false resolve. 0 means a senior takes over instead. */
  falseResolvePct: number;
  /** How likely each difficulty is when a new ticket is generated. */
  difficultyWeights: Record<Difficulty, number>;
}

export const RANKS: Rank[] = [
  {
    name: 'Tier 1 NOC Technician',
    uptimeTarget: 0.9,
    slaTarget: 0.8,
    maxOpenTickets: 1,
    falseResolvePct: 0,
    difficultyWeights: { trivial: 35, easy: 35, moderate: 25, hard: 4, expert: 1 },
  },
  {
    name: 'Tier 2 NOC Technician',
    uptimeTarget: 0.99,
    slaTarget: 0.9,
    maxOpenTickets: 2,
    falseResolvePct: 0.01,
    difficultyWeights: { trivial: 20, easy: 30, moderate: 35, hard: 11, expert: 4 },
  },
  {
    name: 'Network Engineer',
    uptimeTarget: 0.999,
    slaTarget: 0.95,
    maxOpenTickets: 3,
    falseResolvePct: 0.02,
    difficultyWeights: { trivial: 10, easy: 20, moderate: 35, hard: 25, expert: 10 },
  },
  {
    name: 'NOC Manager',
    uptimeTarget: 0.9999,
    slaTarget: 0.98,
    // No limit: by now you're delegating to the techs you've hired.
    maxOpenTickets: Infinity,
    falseResolvePct: 0.03,
    difficultyWeights: { trivial: 5, easy: 15, moderate: 30, hard: 30, expert: 20 },
  },
];

export const RULES = {
  /** Max speed multiplier for an instant fix; 1.0 exactly at the deadline. */
  maxSpeedBonus: 0.25,
  breachPenalty: 0.5,
  missedResponsePenalty: 0.1,
  triageBonus: 0.1,
  triagePenaltyFarOff: 0.2,
  /** Fixed before the user even reported it. */
  proactiveBonus: 0.2,
  /** A ticket resolved after a false resolve earns this share of its normal score... */
  revisitShare: 0.5,
  /** ...and wins back this share of the penalty. */
  revisitRecovery: 0.5,
  /** Tier 1: how long until a senior takes over a falsely resolved ticket. */
  seniorTakeoverMs: 10 * MIN,
  /** Earned while nothing is broken and no incident is open: 1 point every 2 seconds. */
  healthyPointsPerSecond: 0.5,
  /** Uptime drain per affected user, per service, per minute. */
  drainPerUserMinute: 2,
  shiftBonus: 100,
  shiftPenalty: 100,
};

/** Speed multiplier for resolving after `elapsed` ms against a deadline of `target` ms. */
export function speedMultiplier(elapsed: number, target: number): number {
  if (elapsed <= target) return 1 + RULES.maxSpeedBonus * (1 - elapsed / target);
  return Math.max(0, 1 - (elapsed - target) / target);
}

export interface ScoreLine {
  label: string;
  points: number;
}

export interface ResolveInput {
  difficulty: Difficulty;
  truePriority: Priority;
  /** Priority the player left on the ticket. */
  shownPriority: Priority;
  /** Time from the ticket being opened to the resolve. */
  elapsedMs: number;
  /** Time from opening to the first response, or null if never acknowledged. */
  respondedAfterMs: number | null;
  proactive: boolean;
}

/** Points for a correct resolve, line by line, so the player can see why. */
export function resolveScore(input: ResolveInput): ScoreLine[] {
  const base = BASE_POINTS[input.difficulty];
  const sla = SLA[input.truePriority];
  const lines: ScoreLine[] = [];
  if (input.proactive) {
    lines.push({ label: 'Fixed before anyone reported it', points: Math.round(base * (1 + RULES.maxSpeedBonus)) });
    lines.push({ label: 'Caught it first bonus', points: Math.round(base * RULES.proactiveBonus) });
    return lines;
  }
  const mult = speedMultiplier(input.elapsedMs, sla.resolveMs);
  lines.push({ label: `${input.difficulty[0].toUpperCase()}${input.difficulty.slice(1)} fix, speed ×${mult.toFixed(2)}`, points: Math.round(base * mult) });
  if (input.elapsedMs > sla.resolveMs) lines.push({ label: 'Resolve SLA breached', points: -Math.round(base * RULES.breachPenalty) });
  if (input.respondedAfterMs === null || input.respondedAfterMs > sla.respondMs) {
    lines.push({ label: 'Response SLA missed', points: -Math.round(base * RULES.missedResponsePenalty) });
  }
  const off = Math.abs(input.shownPriority - input.truePriority);
  if (off === 0) lines.push({ label: 'Correct priority', points: Math.round(base * RULES.triageBonus) });
  else if (off >= 2) lines.push({ label: 'Priority far off', points: -Math.round(base * RULES.triagePenaltyFarOff) });
  return lines;
}

/** Lifetime-points penalty for closing a ticket that wasn't fixed. */
export function falseResolvePenalty(rank: Rank, lifetimePoints: number): number {
  return Math.round(Math.max(0, lifetimePoints) * rank.falseResolvePct);
}

export function total(lines: ScoreLine[]): number {
  return lines.reduce((sum, l) => sum + l.points, 0);
}
