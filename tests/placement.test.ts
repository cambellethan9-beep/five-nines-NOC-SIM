import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game';
import { PLACEMENT_STEPS, STEP_MS } from '../src/game/placement';

describe('placement shift', () => {
  it('five real faults; solving them all quickly places you at Network Engineer', () => {
    const g = new Game('place');
    g.introPending = false;
    g.startPlacement();
    expect(g.inPlacement).toBe(true);
    expect(g.queue.openTickets().length).toBe(0); // Owen took the tutorial
    const shiftBefore = g.shiftStart;
    expect(shiftBefore).toBe(Infinity);
    for (let i = 0; i < PLACEMENT_STEPS.length; i++) {
      const d = g.placement!.current!;
      expect(d.check()).toBe(false); // really broken
      expect(g.placement!.check()).toBe(false);
      g.tick(60_000);
      d.fix();
      expect(g.placement!.check()).toBe(true);
    }
    expect(g.placement!.state.done).toBe(true);
    expect(g.placement!.state.placedRank).toBe(2);
    g.finishPlacement();
    expect(g.queue.rankIndex).toBe(2);
    expect(g.started).toBe(true);
    expect(g.queue.lifetimePoints).toBe(0);
    g.tick(1000);
    expect(g.achievements.has('placed')).toBe(true);
  });

  it('running out of time on everything leaves you at Tier 1, and the network is fixed behind you', () => {
    const g = new Game('place2');
    g.introPending = false;
    g.startPlacement();
    for (let i = 0; i < PLACEMENT_STEPS.length; i++) g.tick(STEP_MS + 5000);
    expect(g.placement!.state.done).toBe(true);
    expect(g.placement!.state.results.every((r) => !r.solved)).toBe(true);
    expect(g.placement!.state.placedRank).toBe(0);
    g.finishPlacement();
    expect(g.queue.rankIndex).toBe(0);
  });

  it('a save in the middle of the test resumes on the same ticket', () => {
    const g = new Game('place3');
    g.introPending = false;
    g.startPlacement();
    g.placement!.current!.fix();
    g.placement!.check();
    const subject = g.placement!.current!.subject;
    const loaded = new Game('place3', JSON.parse(JSON.stringify(g.toSave())));
    expect(loaded.inPlacement).toBe(true);
    expect(loaded.placement!.current!.subject).toBe(subject);
    expect(loaded.placement!.current!.check()).toBe(false);
  });
});
