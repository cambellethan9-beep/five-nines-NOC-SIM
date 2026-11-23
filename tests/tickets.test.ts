import { describe, expect, it } from 'vitest';
import { buildOffice } from '../src/content/office';
import { Game } from '../src/game/game';
import { falseResolvePenalty, RANKS, resolveScore, speedMultiplier, total } from '../src/game/scoring';
import { TEMPLATES } from '../src/game/templates';
import { Rng } from '../src/sim/rng';
import { run } from './helpers';

const MIN = 60_000;

describe('scoring rules', () => {
  it('speed multiplier: 1.25 instantly, 1.0 at the deadline, 0 at double', () => {
    expect(speedMultiplier(0, 60 * MIN)).toBe(1.25);
    expect(speedMultiplier(60 * MIN, 60 * MIN)).toBe(1);
    expect(speedMultiplier(90 * MIN, 60 * MIN)).toBe(0.5);
    expect(speedMultiplier(130 * MIN, 60 * MIN)).toBe(0);
  });

  it('scores the tutorial ticket fixed in 6 minutes with the right priority', () => {
    const lines = resolveScore({ difficulty: 'trivial', truePriority: 3, shownPriority: 3, elapsedMs: 6 * MIN, respondedAfterMs: MIN, proactive: false });
    expect(total(lines)).toBe(53); // 40 × 1.225 = 49, +4 correct priority
  });

  it('an expert build at its deadline is worth about 300', () => {
    const lines = resolveScore({ difficulty: 'expert', truePriority: 4, shownPriority: 4, elapsedMs: 120 * MIN, respondedAfterMs: MIN, proactive: false });
    expect(total(lines)).toBe(330);
  });

  it('breaches, missed responses and bad triage cost points', () => {
    const lines = resolveScore({ difficulty: 'moderate', truePriority: 1, shownPriority: 4, elapsedMs: 20 * MIN, respondedAfterMs: null, proactive: false });
    const labels = lines.map((l) => l.label);
    expect(labels).toContain('Resolve SLA breached');
    expect(labels).toContain('Response SLA missed');
    expect(labels).toContain('Priority far off');
  });

  it('false-resolve penalty grows with rank, up to 3% of lifetime points', () => {
    expect(falseResolvePenalty(RANKS[0], 10_000)).toBe(0);
    expect(falseResolvePenalty(RANKS[1], 10_000)).toBe(100);
    expect(falseResolvePenalty(RANKS[4], 10_000)).toBe(300);
  });
});

describe('ticket templates', () => {
  for (const template of TEMPLATES) {
    it(`${template.id}: breaks something real, check fails until it's fixed`, () => {
      const office = buildOffice('tpl');
      const ctx = { net: office.net, office, rng: new Rng(template.id), busyPcs: new Set([office.tutorial.pcId]), activeTemplates: new Set<string>(), usedTemplates: new Set<string>() };
      expect(template.canStart(ctx)).toBe(true);
      const params = template.plan(ctx);
      // Params must survive a save as plain JSON.
      const draft = template.build(ctx, JSON.parse(JSON.stringify(params)));
      draft.inject();
      expect(draft.check()).toBe(false);
      draft.fix();
      expect(draft.check()).toBe(true);
    });
  }
});

describe('ticket queue', () => {
  it('opens the tutorial ticket at shift start', () => {
    const game = new Game('q');
    const t = game.queue.tickets[0];
    expect(t.id).toBe('INC-1001');
    expect(t.draft.reporter.name).toBe('Priya Natarajan');
    expect(t.priority).toBe(3);
  });

  it('Tier 1 false resolve: no points, a senior takes over and actually fixes it', () => {
    const game = new Game('q');
    const t = game.queue.tickets[0];
    const r = game.queue.resolve(t.id, 'Rebooted the PC');
    expect(r.ok).toBe(false);
    expect(t.status).toBe('escalated');
    expect(t.score).toEqual([]);
    game.tick(11 * MIN);
    expect(t.status).toBe('senior-resolved');
    expect(game.tutorialSolved()).toBe(true);
  });

  it('fixing an escalated ticket before the senior arrives gives half credit', () => {
    const game = new Game('q');
    const t = game.queue.tickets[0];
    game.queue.resolve(t.id, '');
    run(game.net, 'acc1', ['en', 'conf t', 'int fa0/7', 'no shut', 'end']);
    const r = game.queue.resolve(t.id, 'Port was shut');
    expect(r.ok).toBe(true);
    expect(r.lines[0].label).toMatch(/second attempt/);
    expect(total(r.lines)).toBeGreaterThan(0);
    expect(total(r.lines)).toBeLessThan(40);
  });

  it('a correct first resolve scores full points', () => {
    const game = new Game('q');
    const t = game.queue.tickets[0];
    game.queue.acknowledge(t.id);
    run(game.net, 'acc1', ['en', 'conf t', 'int fa0/7', 'no shut', 'end']);
    const r = game.queue.resolve(t.id, 'no shut on Fa0/7');
    expect(r.ok).toBe(true);
    expect(total(r.lines)).toBeGreaterThanOrEqual(50);
  });

  it('NOC Manager false resolve costs 3% of lifetime points; fixing it later recovers half', () => {
    const game = new Game('q');
    game.queue.rankIndex = 4;
    game.queue.lifetimePoints = 10_000;
    const t = game.queue.tickets[0];
    const bad = game.queue.resolve(t.id, '');
    expect(total(bad.lines)).toBe(-300);
    expect(t.status).toBe('reopened');
    run(game.net, 'acc1', ['en', 'conf t', 'int fa0/7', 'no shut', 'end']);
    const good = game.queue.resolve(t.id, '');
    expect(good.lines.find((l) => l.label.startsWith('Recovered'))?.points).toBe(150);
  });

  it('a fault fixed before anyone reports it is credited as caught early', () => {
    const game = new Game('q');
    expect(game.queue.startTemplate('default-route', 3 * MIN)).toBe(true);
    game.tick(30_000);
    expect(game.drainPerMinute).toBeGreaterThan(0); // the whole office lost the internet
    run(game.net, 'rtr1', ['en', 'conf t', 'ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'end']);
    game.tick(20_000);
    const t = game.queue.tickets.find((x) => x.draft.templateId === 'default-route')!;
    expect(t.proactive).toBe(true);
    expect(t.status).toBe('resolved');
    expect(t.score.some((l) => l.label === 'Caught it first bonus')).toBe(true);
  });

  it('the SLA clock runs on the true priority, whatever the ticket says', () => {
    const game = new Game('q');
    game.queue.startTemplate('default-route', 0);
    game.tick(5_000);
    const t = game.queue.tickets.find((x) => x.draft.templateId === 'default-route')!;
    game.queue.setPriority(t.id, 4);
    game.tick(16 * MIN);
    expect(t.breached).toBe(true); // P1: 15 minutes, even though it's marked P4
  });

  it('downtime drains points and lowers availability', () => {
    const game = new Game('q');
    game.queue.startTemplate('default-route', 10 * MIN);
    game.tick(5 * MIN);
    const stats = game.shiftStats();
    expect(stats.drain).toBeGreaterThan(100);
    expect(stats.availability).toBeLessThan(0.9);
  });

  it('the shift ends after 60 minutes with a report, and time stops until the next shift', () => {
    const game = new Game('q');
    game.tick(61 * MIN);
    expect(game.report).not.toBeNull();
    const t = game.net.time;
    game.tick(MIN);
    expect(game.net.time).toBe(t);
    game.startNextShift();
    expect(game.report).toBeNull();
    expect(game.queue.shift).toBe(2);
  });

  it('Tier 1: only one ticket in play at a time, so the tutorial must be solved before anything else breaks', () => {
    const game = new Game('stream');
    game.tick(25 * MIN);
    expect(game.queue.tickets).toHaveLength(1);
    expect(game.queue.inPlay()).toBe(1);
    expect(game.health.affectedUsers).toBeLessThanOrEqual(1);
  });

  it('Tier 1: a player who keeps up gets a steady stream, never more than one at once', () => {
    const game = new Game('stream');
    for (let i = 0; i < 58; i++) {
      game.tick(MIN);
      expect(game.queue.inPlay()).toBeLessThanOrEqual(1);
      for (const t of game.queue.openTickets()) {
        t.draft.fix();
        game.queue.resolve(t.id, '');
      }
    }
    expect(game.queue.tickets.length).toBeGreaterThanOrEqual(4);
    expect(game.queue.tickets.length).toBeLessThanOrEqual(10);
  });

  it('higher ranks juggle more tickets at once', () => {
    const game = new Game('stream2');
    game.queue.rankIndex = 2; // Network Engineer: up to 3
    let peak = 0;
    for (let i = 0; i < 50; i++) {
      game.tick(MIN);
      peak = Math.max(peak, game.queue.inPlay());
      expect(game.queue.inPlay()).toBeLessThanOrEqual(3);
    }
    expect(peak).toBe(3);
  });

  it('NOC Manager has no limit on simultaneous tickets', () => {
    const game = new Game('stream3');
    game.queue.rankIndex = 4;
    let peak = 0;
    for (let i = 0; i < 50; i++) {
      game.tick(MIN);
      peak = Math.max(peak, game.queue.inPlay());
    }
    expect(peak).toBeGreaterThan(4);
  });
});

describe('shift start', () => {
  it('only the tutorial is broken when the shift starts; the next fault comes a few minutes in', () => {
    const game = new Game('start');
    expect(game.health.affectedUsers).toBe(1);
    game.tick(2 * MIN);
    expect(game.queue.tickets).toHaveLength(1);
  });
});

describe('telling the user it is fixed', () => {
  it('a fixed but untold user keeps draining and asks for an update; telling them stops it', () => {
    const game = new Game('notify');
    game.introPending = false;
    game.queue.tickets[0].draft.fix();
    game.queue.resolve('INC-1001', 'fixed');
    game.tick(5_000);
    expect(game.waitingUsers).toEqual([game.queue.find('INC-1001').draft.reporter.pcId]);
    expect(game.healthy).toBe(false);
    expect(game.pointsPerMinute).toBeLessThan(0);
    const pc = game.queue.find('INC-1001').draft.reporter.pcId;
    game.tick(10 * 60_000);
    expect(game.chat.conv(pc).messages.some((m) => m.from === pc && /ticket|heard|fixed/i.test(m.text))).toBe(true);
    expect(game.notifyUser('INC-1001', 'direct')).toBeNull();
    expect(game.waitingUsers).toEqual([]);
    game.tick(60_000);
    expect(game.chat.conv(pc).messages.at(-1)!.from).toBe(pc); // they thank you
    expect(game.notifyUser('INC-1001', 'direct')).toContain('already knows');
  });

  it('coworkers tell the user themselves', () => {
    const game = new Game('notify2');
    game.introPending = false;
    game.queue.escalate('INC-1001', 'jordan');
    game.tick(20 * 60_000);
    const t = game.queue.tickets.find((x) => x.id === 'INC-1001')!;
    if (t.status === 'senior-resolved') expect(t.notifiedAt).not.toBeNull();
    expect(game.waitingUsers).toEqual([]);
  });
});

describe('healthy network income', () => {
  it('earns 1 point every 2 seconds while nothing is broken and nothing is open', () => {
    const game = new Game('healthy');
    game.queue.tickets[0].draft.fix();
    game.queue.resolve('INC-1001', 'fixed');
    game.notifyUser('INC-1001', 'direct');
    game.tick(5_000);
    expect(game.healthy).toBe(true);
    expect(game.pointsPerMinute).toBe(30);
    const before = game.shiftStats().healthy;
    game.tick(60_000); // the next ticket can't start for at least 90 seconds
    expect(game.shiftStats().healthy - before).toBe(30);
  });

  it('pauses while an incident ticket is still open, even if the fix is in', () => {
    const game = new Game('healthy');
    game.queue.tickets[0].draft.fix(); // fixed but not resolved
    game.tick(5_000);
    expect(game.health.brokenPairs).toBe(0);
    expect(game.healthy).toBe(false);
    game.tick(60_000);
    expect(game.shiftStats().healthy).toBe(0);
  });

  it('keeps paying during planned work like a change request', () => {
    const game = new Game('healthy');
    game.queue.tickets[0].draft.fix();
    game.queue.resolve('INC-1001', 'fixed');
    game.notifyUser('INC-1001', 'direct');
    game.queue.startTemplate('partner-vlan', 0);
    game.tick(5_000);
    expect(game.queue.openTickets().map((t) => t.draft.kind)).toEqual(['request']);
    expect(game.healthy).toBe(true);
  });

  it('turns into a drain the moment something breaks', () => {
    const game = new Game('healthy');
    expect(game.pointsPerMinute).toBeLessThan(0); // Priya's port is down at the start
  });
});
