// Achievements: titles for lifetime points (the career ladder in jokes) plus feats for doing something hard well.
// Everything is worked out from game state, so nothing has to be recorded as it happens except ROMMON recoveries.

import type { Game } from './game';

export interface Achievement {
  id: string;
  name: string;
  description: string;
  /** Lifetime-point tiers sort by this; feats leave it out. */
  points?: number;
  /** Hidden until earned (a surprise). */
  secret?: boolean;
}

export const POINT_TIERS: Achievement[] = [
  { id: 'pts-1k', points: 1_000, name: 'The Okayest Intern Ever', description: 'Earn 1,000 lifetime points.' },
  { id: 'pts-5k', points: 5_000, name: 'Knows Where the Closets Are', description: 'Earn 5,000 lifetime points.' },
  { id: 'pts-10k', points: 10_000, name: 'Ping Whisperer', description: 'Earn 10,000 lifetime points.' },
  { id: 'pts-25k', points: 25_000, name: 'Keeper of the Cable Drawer', description: 'Earn 25,000 lifetime points.' },
  { id: 'pts-50k', points: 50_000, name: 'Subnet Sommelier', description: 'Earn 50,000 lifetime points.' },
  { id: 'pts-100k', points: 100_000, name: 'Spanning Tree Hugger', description: 'Earn 100,000 lifetime points.' },
  { id: 'pts-250k', points: 250_000, name: 'Lord of the Change Window', description: 'Earn 250,000 lifetime points.' },
  { id: 'pts-500k', points: 500_000, name: 'Packet Shepherd', description: 'Earn 500,000 lifetime points.' },
  { id: 'pts-1m', points: 1_000_000, name: 'Five Nines, In Person', description: 'Earn 1,000,000 lifetime points.' },
];

export const FEATS: Achievement[] = [
  { id: 'first-ticket', name: 'Ticket Closed, Coffee Opened', description: 'Resolve your first ticket yourself.' },
  { id: 'first-change', name: 'Change Approved', description: 'Complete a change request.' },
  { id: 'expert', name: 'Above Your Pay Grade', description: 'Solve an expert ticket without help.' },
  { id: 'p1-fast', name: 'Fastest Fingers in the NOC', description: 'Resolve a real P1 within 5 minutes of it being reported.' },
  { id: 'storm', name: 'Storm Chaser', description: 'Stop a broadcast storm within 5 minutes of the report.', secret: true },
  { id: 'saw-it-coming', name: 'Saw It Coming', description: 'Declare an incident before the first user calls about it.' },
  { id: 'rommon', name: 'Back From the Dead', description: 'Bring a device back from ROMMON.', secret: true },
  { id: 'solo-shift', name: "Didn't Phone a Friend", description: 'Finish a shift with at least 3 tickets and no escalations.' },
  { id: 'streak-10', name: 'Reliable Like Ethernet', description: 'Reach a 10-shift reliability streak.' },
  { id: 'hundred', name: 'Centurion of the Queue', description: 'Resolve 100 tickets yourself.' },
  { id: 'rank-1', name: 'Off the Phones', description: 'Get promoted to Tier 2.' },
  { id: 'rank-2', name: 'Trusted With Enable', description: 'Become a Network Engineer (NOC Tier 3).' },
  { id: 'rank-3', name: 'Has a Team Now', description: 'Become a NOC Supervisor.' },
  { id: 'rank-4', name: 'Owns the Building', description: 'Become the NOC Manager.' },
  { id: 'mentor', name: 'Paying It Forward', description: 'Get your intern promoted to Tier 1 NOC.' },
  { id: 'placed', name: 'Skipped the Line', description: 'Place above Tier 1 in the placement shift.' },
];

export const ALL_ACHIEVEMENTS = [...POINT_TIERS, ...FEATS];

export interface AchievementState {
  unlocked: Record<string, number>;
  /** Devices seen in ROMMON (to notice them coming back). */
  inRommon: string[];
  /** Placement result, if the placement shift was taken. */
  placedRank?: number;
}

const MIN = 60_000;

export class Achievements {
  state: AchievementState = { unlocked: {}, inRommon: [] };
  /** Unlocked since the UI last looked (for the toast). */
  fresh: Achievement[] = [];

  has(id: string): boolean {
    return id in this.state.unlocked;
  }

  private unlock(id: string, now: number): void {
    if (this.has(id)) return;
    this.state.unlocked[id] = now;
    const a = ALL_ACHIEVEMENTS.find((x) => x.id === id);
    if (a) this.fresh.push(a);
  }

  /** Called every tick. Cheap: a pass over tickets and a handful of numbers. */
  evaluate(game: Game): void {
    const now = game.net.time;
    const q = game.queue;
    for (const t of POINT_TIERS) if (q.lifetimePoints >= t.points!) this.unlock(t.id, now);
    const mine = q.tickets.filter((t) => t.status === 'resolved' && !t.resolvedBy && !t.employee);
    if (mine.length) this.unlock('first-ticket', now);
    if (mine.length >= 100) this.unlock('hundred', now);
    if (mine.some((t) => t.draft.kind === 'request')) this.unlock('first-change', now);
    if (mine.some((t) => t.difficulty === 'expert' && !t.escalation)) this.unlock('expert', now);
    const fast = (t: (typeof mine)[number]) => t.resolvedAt !== null && t.resolvedAt - t.openedAt <= 5 * MIN && t.falseResolves === 0;
    if (mine.some((t) => t.truePriority === 1 && fast(t))) this.unlock('p1-fast', now);
    if (mine.some((t) => t.draft.templateId === 'stp-loop' && fast(t))) this.unlock('storm', now);
    if (game.incidents.list.some((i) => i.linked.some((id) => (q.tickets.find((t) => t.id === id)?.faultAt ?? Infinity) <= i.declaredAt))) this.unlock('saw-it-coming', now);
    if (q.streak >= 10) this.unlock('streak-10', now);
    for (let r = 1; r <= q.rankIndex; r++) this.unlock(`rank-${r}`, now);
    if ((this.state.placedRank ?? 0) > 0) this.unlock('placed', now);
    if (game.team.employees.some((e) => e.promotedFromIntern)) this.unlock('mentor', now);
    // ROMMON: a device that was stuck there and now runs again.
    for (const d of game.net.devices.values()) {
      if (d.rommon && !this.state.inRommon.includes(d.id)) this.state.inRommon.push(d.id);
      if (!d.rommon && this.state.inRommon.includes(d.id) && game.net.isOnline(d)) {
        this.state.inRommon = this.state.inRommon.filter((x) => x !== d.id);
        this.unlock('rommon', now);
      }
    }
    // A finished shift with 3+ tickets and no escalations.
    if (game.report && !this.has('solo-shift')) {
      const shiftTickets = q.tickets.filter((t) => t.shift === game.report!.shift);
      if (shiftTickets.length >= 3 && shiftTickets.every((t) => !t.escalation && t.seniorAt === null)) this.unlock('solo-shift', now);
    }
  }

  /** The best lifetime-point title earned so far. */
  title(): string | null {
    const earned = POINT_TIERS.filter((t) => this.has(t.id));
    return earned.length ? earned[earned.length - 1].name : null;
  }

  exportState(): AchievementState {
    return structuredClone(this.state);
  }

  importState(s: AchievementState | undefined): void {
    if (s) this.state = { unlocked: s.unlocked ?? {}, inRommon: s.inRommon ?? [], ...(s.placedRank !== undefined ? { placedRank: s.placedRank } : {}) };
  }
}
