import { describe, expect, it } from 'vitest';
import { Game, WALK_MS } from '../src/game/game';

describe('game layer', () => {
  it('walking to another console costs 30 seconds; staying put is free', () => {
    const game = new Game('t');
    const start = game.net.time;
    expect(game.walkTo('noc')).toBe(false);
    expect(game.net.time).toBe(start);
    expect(game.walkTo('acc1')).toBe(true);
    expect(game.net.time).toBe(start + WALK_MS);
    expect(game.walkTo('noc')).toBe(true);
    expect(game.net.time).toBe(start + 2 * WALK_MS);
  });

  it("can't walk to the ISP's gear", () => {
    const game = new Game('t');
    expect(game.walkTo('isp')).toBe(false);
    expect(game.location).toBe('noc');
  });

  it('renaming changes the running config only', () => {
    const game = new Game('t');
    expect(game.rename('acc1', 'bad name')).toMatch(/letters, numbers and hyphens/);
    expect(game.rename('acc1', 'CR-ACC1-FL1')).toBeNull();
    const d = game.net.device('acc1');
    expect(d.running.hostname).toBe('CR-ACC1-FL1');
    expect(d.startup!.hostname).toBe('CR-ACC1');
    expect(game.configUnsaved(d)).toBe(true);
  });

  it('records monitoring history while time passes', () => {
    const game = new Game('t');
    game.tick(60_000);
    expect(game.history.get('core1')!.length).toBeGreaterThanOrEqual(12);
    expect(game.monitored().some((d) => d.id.startsWith('ws'))).toBe(false);
  });

  it('the predecessor docs include the tutorial user in the port map', () => {
    const game = new Game('t');
    const portmap = game.docs.find((d) => d.id === 'portmap')!;
    const table = portmap.blocks.find((b) => 'table' in b) as { table: { rows: string[][] } };
    expect(table.table.rows).toContainEqual(['1-07', 'Priya Natarajan', 'Tax', 'CR-WS07', '10.10.10.107', 'CR-ACC1', 'Fa0/7', '10']);
  });
});
