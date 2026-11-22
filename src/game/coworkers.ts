// The people above (and next to) you in the NOC. Escalating hands a ticket to one of them:
// they really fix it (the network changes), you get partial credit, and they tell you what was wrong.

import type { Difficulty } from './scoring';

export type CoworkerId = 'jordan' | 'owen' | 'gloria';

export interface Coworker {
  id: CoworkerId;
  name: string;
  title: string;
  /** Index into RANKS. You can only escalate to people above you. */
  rankIndex: number;
  tenure: string;
  /** How long they take, in game ms. */
  minMs: number;
  maxMs: number;
  /** Share of the ticket's base points you still get. */
  credit: number;
  /** Chance they actually solve a ticket of each difficulty. */
  success: Record<Difficulty, number>;
  blurb: string;
}

const MIN = 60_000;

export const COWORKERS: Coworker[] = [
  {
    id: 'jordan',
    name: 'Jordan Reyes',
    title: 'Tier 1 NOC Technician',
    rankIndex: 0,
    tenure: 'started 6 months before you',
    minMs: 8 * MIN,
    maxMs: 15 * MIN,
    credit: 0.5,
    success: { trivial: 0.95, easy: 0.8, moderate: 0.4, hard: 0, expert: 0 },
    blurb: 'A little more experience than you. Fine for the simple stuff.',
  },
  {
    id: 'owen',
    name: 'Owen Price',
    title: 'Tier 2 NOC Technician',
    rankIndex: 1,
    tenure: '2 years here',
    minMs: 6 * MIN,
    maxMs: 12 * MIN,
    credit: 0.35,
    success: { trivial: 1, easy: 1, moderate: 0.95, hard: 0.75, expert: 0.4 },
    blurb: "Responsible for you and Jordan. Teaching is part of his job, and he'll tell you about it.",
  },
  {
    id: 'gloria',
    name: 'Gloria Haines',
    title: 'NOC Manager',
    rankIndex: 3,
    tenure: '10 years here',
    minMs: 4 * MIN,
    maxMs: 8 * MIN,
    credit: 0.25,
    success: { trivial: 1, easy: 1, moderate: 1, hard: 1, expert: 1 },
    blurb: 'Solves anything. Save her for critical or really complex problems.',
  },
];

export function coworker(id: string): Coworker {
  const c = COWORKERS.find((x) => x.id === id);
  if (!c) throw new Error(`No coworker ${id}`);
  return c;
}

/** You escalate upward. A fellow Tier 1 with more time in the job is fair game while you're both Tier 1. */
export function canEscalateTo(c: Coworker, playerRank: number): boolean {
  return c.rankIndex > playerRank || (c.id === 'jordan' && playerRank === 0);
}

/** Gloria doesn't want routine tickets. */
export function wastesManagersTime(c: Coworker, difficulty: Difficulty, truePriority: number): boolean {
  return c.id === 'gloria' && truePriority >= 3 && (difficulty === 'trivial' || difficulty === 'easy');
}

/** Owen's random facts, a few per shift. */
export const OWEN_TIPS = [
  'Random fact: `show interfaces status` on a switch shows every port, its VLAN and whether it\'s connected, disabled or err-disabled. Fastest way to find a dead desk.',
  'Random fact: a port that says "administratively down" was shut on purpose by someone. "down/down" is usually a cable, a PC that\'s off, or a dead NIC.',
  'Random fact: unused switch ports sit in VLAN 1 by default. That bites people every time someone moves desks.',
  'Random fact: `show interfaces trunk` tells you which VLANs a trunk actually carries. "Allowed" and "active" aren\'t the same thing.',
  'Random fact: two ends hard-coded to different speeds never come up. Leave both on auto unless you have a reason.',
  'Random fact: `show ip route` on the router answers "can we get there from here?" before you go chasing cables.',
  'Random fact: `do` lets you run show commands without leaving config mode. `do show run | section interface` saves a lot of typing.',
  'Random fact: write memory. Every time. A reload throws away anything that isn\'t in the startup config.',
  'Random fact: ping from the device closest to the problem first. A failing ping from your desk tells you something is broken, not where.',
  'Random fact: CDP will tell you what\'s on the other end of a cable: `show cdp neighbors detail` even gives you the neighbor\'s IP.',
  'Random fact: a 169.254.x.x address on a PC means it asked for an IP and nobody answered. Different problem from a wrong static IP.',
  'Random fact: router-on-a-stick needs the router port facing a trunk, one subinterface per VLAN, and `encapsulation dot1Q <vlan>` before the IP.',
  'Random fact: the native VLAN goes across a dot1Q trunk untagged. Mismatch it on the two ends and traffic leaks between VLANs.',
  'Random fact: if the logs say %LINK-5-CHANGED "administratively down", search the logs a few lines up for who configured it.',
];
