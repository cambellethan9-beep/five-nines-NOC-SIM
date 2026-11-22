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
  /** Share of base points subtracted when you resolve a trivial or easy ticket yourself instead of delegating. */
  menialPenaltyPct: number;
  /** How likely each difficulty is when a new ticket is generated. */
  difficultyWeights: Record<Difficulty, number>;
  /** To be promoted out of this rank: score at least `pointsPerShift` in `shifts` shifts in a row. */
  promotion?: { pointsPerShift: number; shifts: number };
}

export const RANKS: Rank[] = [
  {
    name: 'Tier 1 NOC Technician',
    uptimeTarget: 0.9,
    slaTarget: 0.8,
    maxOpenTickets: 1,
    falseResolvePct: 0,
    menialPenaltyPct: 0,
    difficultyWeights: { trivial: 35, easy: 35, moderate: 25, hard: 4, expert: 1 },
    promotion: { pointsPerShift: 500, shifts: 5 },
  },
  {
    name: 'Tier 2 NOC Technician',
    uptimeTarget: 0.99,
    slaTarget: 0.9,
    maxOpenTickets: 2,
    falseResolvePct: 0.01,
    menialPenaltyPct: 0,
    difficultyWeights: { trivial: 20, easy: 30, moderate: 35, hard: 11, expert: 4 },
    promotion: { pointsPerShift: 1000, shifts: 10 },
  },
  {
    name: 'Network Engineer (NOC Tier 3)',
    uptimeTarget: 0.999,
    slaTarget: 0.95,
    maxOpenTickets: 3,
    falseResolvePct: 0.02,
    menialPenaltyPct: 0,
    difficultyWeights: { trivial: 10, easy: 20, moderate: 35, hard: 25, expert: 10 },
    promotion: { pointsPerShift: 2000, shifts: 20 },
  },
  {
    name: 'NOC Supervisor',
    uptimeTarget: 0.9999,
    slaTarget: 0.97,
    maxOpenTickets: 4,
    falseResolvePct: 0.025,
    menialPenaltyPct: 0.1,
    difficultyWeights: { trivial: 7, easy: 17, moderate: 33, hard: 28, expert: 15 },
    promotion: { pointsPerShift: 5000, shifts: 20 },
  },
  {
    // Ranks above this will need other prerequisites (facilities managed and so on).
    name: 'NOC Manager',
    uptimeTarget: 0.99999,
    slaTarget: 0.98,
    // No limit: by now you're delegating to the techs you've hired.
    maxOpenTickets: Infinity,
    falseResolvePct: 0.03,
    menialPenaltyPct: 0.2,
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
  /** Escalating a routine (P3/P4, trivial/easy) ticket to the NOC Manager. */
  managerTimePenalty: 0.2,
  /** Earned while nothing is broken and no incident is open: 1 point every 2 seconds. */
  healthyPointsPerSecond: 0.5,
  /** Uptime drain per affected user, per service, per minute. */
  drainPerUserMinute: 2,
  shiftBonus: 100,
  shiftPenalty: 100,
  /** Reliability streak: each shift in a row that reaches the rank's points bar pays this × the streak... */
  streakPointsPerShift: 50,
  /** ...counting at most this many shifts. */
  streakCap: 10,
};

/** 0.9 -> 1, 0.99 -> 2, 0.99999 -> 5. */
export function nines(target: number): number {
  return Math.max(0, Math.round(-Math.log10(1 - target)));
}

/** One nine multiplies the streak bonus by 1.1, two by 1.2, five nines by 1.5. */
export function ninesMultiplier(target: number): number {
  return 1 + 0.1 * nines(target);
}

/** The score a shift needs to count as reliable: the rank's promotion bar (the last one at the top rank). */
export function pointsBar(rankIndex: number): number {
  for (let i = rankIndex; i >= 0; i--) {
    const p = RANKS[i].promotion;
    if (p) return p.pointsPerShift;
  }
  return 0;
}

/** The reliability bonus for a shift that extends the streak to `streak`. */
export function streakBonus(streak: number, uptimeTarget: number): number {
  return Math.round(RULES.streakPointsPerShift * Math.min(streak, RULES.streakCap) * ninesMultiplier(uptimeTarget));
}

/** A shift under the points bar wipes the streak: it has to be rebuilt from 0. */
export function streakAfterMiss(_streak: number): number {
  return 0;
}

/** Routine work a senior shouldn't be doing by hand. */
export function isMenial(difficulty: Difficulty): boolean {
  return difficulty === 'trivial' || difficulty === 'easy';
}

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
