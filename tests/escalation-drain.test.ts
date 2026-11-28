import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game';
import { planGenerated, planHardware } from '../src/game/generator';
import type { Difficulty } from '../src/game/scoring';

function quiet(seed: string) {
  const g = new Game(seed);
  g.introPending = false;
  g.declinePlacement();
  g.queue.tickets[0].draft.fix();
  g.queue.resolve('INC-1001', 'x');
  g.notifyUser('INC-1001', 'direct');
  g.breakage.nextAt = Infinity;
  (g.queue as unknown as { nextTicketAt: number }).nextTicketAt = Infinity;
  g.tick(10_000);
  return g;
}

function escalateAndWait(g: Game) {
  const t = g.queue.openTickets()[0];
  const to = g.queue.escalationTargets().find((c) => c.id !== 'jordan') ?? g.queue.escalationTargets()[0];
  g.queue.escalate(t.id, to.id);
  t.escalation!.success = true;
  for (let k = 0; k < 480 && t.status === 'escalated'; k++) g.tick(5000);
  (g.queue as unknown as { nextTicketAt: number }).nextTicketAt = Infinity;
  g.tick(30_000);
  return t;
}

describe('a coworker fix really stops the drain', () => {
  it('rogue DHCP: PCs that took a rogue lease are renewed too', () => {
    const g = quiet('esc-rogue');
    expect(g.queue.startTemplate('rogue-dhcp', 0)).toBe(true);
    g.tick(10_000);
    const t = escalateAndWait(g);
    expect(t.status).toBe('senior-resolved');
    expect(g.health.brokenPairs).toBe(0);
    expect(g.drainPerMinute).toBe(0);
  });

  it('generated and hardware tickets: nobody is left broken', () => {
    const order: Difficulty[] = ['trivial', 'easy', 'moderate', 'hard', 'expert'];
    const hw = ['cable-bad', 'infra-cable', 'nic-dead', 'port-dead'];
    for (let i = 0; i < 12; i++) {
      const g = quiet(`esc-gen-${i}`);
      g.queue.rankIndex = i % 4;
      const params = i >= 8 ? planHardware(g.queue.context(), hw[i % 4]) : planGenerated(g.queue.context(), order[i % 5], i % 4);
      if (!params || !g.queue.startGenerated(params, 0)) continue;
      g.tick(10_000);
      const t = escalateAndWait(g);
      expect(t.status, String(t.draft.params.atoms)).toBe('senior-resolved');
      expect(g.health.brokenPairs, String(t.draft.params.atoms)).toBe(0);
    }
  });

  it('an unreported problem is counted, so leftover drain has an explanation', () => {
    const g = quiet('esc-unrep');
    expect(g.queue.startTemplate('port-shutdown', 5 * 60_000)).toBe(true);
    g.tick(10_000);
    expect(g.queue.unreported()).toBe(1);
    expect(g.drainPerMinute).toBeGreaterThan(0);
  });
});
