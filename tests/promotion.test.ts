import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game';
import { nines, ninesMultiplier, RANKS, streakAfterMiss, streakBonus } from '../src/game/scoring';

const MIN = 60_000;

/** Plays a shift that ends with roughly `extra` points on top of whatever happened. */
function playShift(game: Game, extra: number) {
  game.queue.addPoints('test', extra);
  game.tick(61 * MIN);
  const report = game.report!;
  game.startNextShift();
  return report;
}

describe('rank ladder', () => {
  it('five ranks with the agreed thresholds; the Manager target is five nines', () => {
    expect(RANKS.map((r) => r.name)).toEqual([
      'Tier 1 NOC Technician',
      'Tier 2 NOC Technician',
      'Network Engineer (NOC Tier 3)',
      'NOC Supervisor',
      'NOC Manager',
    ]);
    expect(RANKS.map((r) => r.promotion && [r.promotion.pointsPerShift, r.promotion.shifts])).toEqual([
      [500, 5],
      [1000, 10],
      [2000, 20],
      [5000, 20],
      undefined,
    ]);
    expect(RANKS.map((r) => nines(r.uptimeTarget))).toEqual([1, 2, 3, 4, 5]);
    expect(RANKS.map((r) => r.maxOpenTickets)).toEqual([1, 2, 3, 4, Infinity]);
  });
});

describe('reliability streak', () => {
  it('pays more each shift in a row, scaled by the nines of the target', () => {
    expect(ninesMultiplier(0.9)).toBeCloseTo(1.1);
    expect(ninesMultiplier(0.99999)).toBeCloseTo(1.5);
    expect(streakBonus(1, 0.9)).toBe(55);
    expect(streakBonus(5, 0.9)).toBe(275);
    expect(streakBonus(5, 0.99)).toBe(300);
    expect(streakBonus(15, 0.99999)).toBe(750); // capped at 10 shifts
    expect(streakAfterMiss(7)).toBe(0);
  });

  it('follows the points bar, not uptime, and is saved', () => {
    const game = new Game('streak');
    game.queue.tickets[0].draft.fix();
    const r = playShift(game, 5000);
    expect(r.streak).toBe(1);
    expect(r.streakBonus).toBe(55);
    expect(playShift(game, 5000).streakBonus).toBe(110);
    expect(playShift(game, -5000)).toMatchObject({ streak: 0, streakBonus: 0 });
    expect(playShift(game, 5000).streakBonus).toBe(55); // starts over
    const restored = new Game(game.seed, JSON.parse(JSON.stringify(game.toSave())));
    expect(restored.queue.streak).toBe(game.queue.streak);
  });
});

describe('promotion', () => {
  it('5 shifts in a row at 500+ makes you Tier 2; the progress survives a save in between', () => {
    let game = new Game('promo');
    game.queue.tickets[0].draft.fix();
    for (let i = 1; i <= 4; i++) expect(playShift(game, 5000).promotion!.done).toBe(i);
    game = new Game(game.seed, JSON.parse(JSON.stringify(game.toSave()))); // come back after studying
    const r = playShift(game, 5000);
    expect(r.promotion!.promotedTo).toBe('Tier 2 NOC Technician');
    expect(game.queue.rankIndex).toBe(1);
    expect(game.queue.qualifyingShifts).toBe(0);
    expect(game.queue.rank.maxOpenTickets).toBe(2);
  });

  it('one shift under the threshold starts the count over', () => {
    const game = new Game('promo2');
    game.queue.tickets[0].draft.fix();
    playShift(game, 5000);
    playShift(game, 5000);
    const miss = playShift(game, -5000);
    expect(miss.promotion).toMatchObject({ qualified: false, done: 0 });
    expect(playShift(game, 5000).promotion!.done).toBe(1);
    expect(game.queue.rankIndex).toBe(0);
  });
});

describe('senior ranks delegate routine work', () => {
  function seniorGame(rank: number) {
    const game = new Game('menial');
    game.queue.rankIndex = rank;
    const t = game.queue.tickets[0]; // the tutorial: a trivial port shutdown
    return { game, t };
  }

  it('a Supervisor fixing a trivial ticket by hand loses a little; a Tier 2 does not', () => {
    for (const [rank, expected] of [[1, 0], [3, -4], [4, -8]] as const) {
      const { game, t } = seniorGame(rank);
      t.draft.fix();
      const r = game.queue.resolve(t.id, 'fixed');
      const line = r.lines.find((l) => l.label.startsWith('Routine ticket done by hand'));
      expect(line?.points ?? 0).toBe(expected);
    }
  });

  it('assigning it down to Jordan pays full base points and no penalty', () => {
    const { game, t } = seniorGame(4);
    expect(game.queue.escalate(t.id, 'jordan')).toMatch(/assigned to Jordan/);
    game.tick(16 * MIN);
    const ev = t.score;
    if (t.status === 'senior-resolved') {
      expect(ev.find((e) => e.label === 'Delegated to Jordan')?.points).toBe(40);
      expect(ev.some((e) => e.label.startsWith('Routine'))).toBe(false);
    } else {
      expect(t.status).toBe('in-progress'); // Jordan handed it back (5% chance on a trivial ticket)
    }
  });
});
