import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game';
import { INTERN_PROMOTION_REWARD } from '../src/game/team';

const MIN = 60_000;
const PORT_RUNBOOK = ['Port down at a desk.', '» ssh {switch}', '» conf t', '» interface {port}', '» no shutdown', '» end'].join('\n');

function withIntern(seed: string, body = PORT_RUNBOOK, triggers = 'S: drive AND my desk\nno network AND desk') {
  const g = new Game(seed);
  g.introPending = false;
  g.declinePlacement();
  const n = g.addNote();
  g.updateNote(n.id, 'Port down at a desk', body);
  g.setRunbook(n.id, { triggers, enabled: true });
  expect(g.team.internBlocked(g)).toContain('Tier 2');
  g.queue.rankIndex = 1;
  const e = g.team.takeIntern(g, g.net.rng)!;
  e.typoRate = 0; // deterministic for the test
  return { g, e };
}

describe('the intern', () => {
  it('picks up a matching ticket, follows your runbook, resolves it, and keeps their own score', () => {
    const { g, e } = withIntern('team1');
    const tut = g.queue.tickets[0];
    g.tick(5000);
    expect(tut.assignedTo).toBe(e.name);
    expect(e.status.kind).toBe('working');
    g.tick(8 * MIN);
    expect(tut.status).toBe('resolved');
    expect(tut.employee).toBe(e.name);
    expect(tut.runLog!.length).toBeGreaterThan(3);
    expect(tut.notifiedAt).not.toBeNull();
    expect(g.team.shiftScore(e, g.queue.shift)).toBeGreaterThan(0);
    expect(e.resolved).toBe(1);
  });

  it('hands a ticket back with the log when the runbook does not fix it', () => {
    const { g, e } = withIntern('team2', 'Look around.\n» ssh {switch}\n» show version');
    const tut = g.queue.tickets[0];
    g.tick(8 * MIN);
    expect(tut.status).not.toBe('resolved');
    expect(tut.assignedTo).toBeUndefined();
    expect(tut.runLog![0].typed).toBe('ssh 10.10.99.11');
    expect(tut.activity.some((a) => a.text.includes('still broken'))).toBe(true);
    expect(e.handedBack).toBe(1);
  });

  it('works tickets in the order of the priority you set', () => {
    const { g, e } = withIntern('team3');
    e.status = { kind: 'training', cert: 'NSCT', remainingRealMs: 1e12 }; // hold them while tickets arrive
    g.queue.tickets[0].draft.fix();
    g.queue.resolve('INC-1001', 'x');
    g.notifyUser('INC-1001', 'direct');
    expect(g.queue.startTemplate('port-shutdown', 0)).toBe(true);
    expect(g.queue.startTemplate('port-shutdown', 0)).toBe(true);
    g.tick(1000);
    const open = g.queue.openTickets();
    expect(open.length).toBe(2);
    open[0].priority = 4;
    open[1].priority = 1;
    e.status = { kind: 'idle' };
    g.tick(1000);
    expect(open[1].assignedTo).toBe(e.name);
    expect(open[0].assignedTo).toBeUndefined();
  });

  it('200+ in five shifts in a row: promoted to Tier 1 NOC and 1,000 points for you', () => {
    const { g, e } = withIntern('team4');
    const before = g.queue.lifetimePoints;
    for (let i = 0; i < 5; i++) {
      e.shiftPoints[g.queue.shift] = 250;
      g.team.endShift(g, g.net.rng);
      g.queue.shift++;
    }
    expect(e.role).toBe('tech');
    expect(e.title).toBe('Tier 1 NOC Technician');
    expect(g.queue.lifetimePoints - before).toBe(INTERN_PROMOTION_REWARD);
    g.tick(1000);
    expect(g.achievements.has('mentor')).toBe(true);
    expect(g.team.internBlocked(g)).toBeNull(); // the intern slot is free again
  });

  it('a miss resets the streak; no promotion within 15 shifts and they leave', () => {
    const { g, e } = withIntern('team5');
    for (let i = 0; i < 4; i++) {
      e.shiftPoints[g.queue.shift] = 250;
      g.team.endShift(g, g.net.rng);
      g.queue.shift++;
    }
    expect(e.qualifying).toBe(4);
    g.team.endShift(g, g.net.rng); // 0 points this shift
    expect(e.qualifying).toBe(0);
    for (let i = 0; i < 12; i++) {
      g.queue.shift++;
      g.team.endShift(g, g.net.rng);
    }
    expect(g.team.intern()).toBeUndefined();
  });

  it('training takes real time, blocks tickets, and earns a certificate', () => {
    const { g, e } = withIntern('team6');
    expect(g.team.train(e.id, 'NSCA', 0)).toContain('requires NSCT');
    expect(g.team.train(e.id, 'NSCT', 0)).toBeNull();
    g.tick(5000);
    expect(g.queue.tickets[0].assignedTo).toBeUndefined(); // training, not working
    const typo = (e.typoRate = 0.08);
    g.realTick(9 * MIN);
    expect(e.certs).toEqual([]);
    g.realTick(MIN);
    expect(e.certs).toEqual(['NSCT']);
    expect(e.typoRate).toBeLessThan(typo);
    expect(e.noticesErrors).toBe(true);
  });

  it('the team and runbooks survive a save', () => {
    const { g, e } = withIntern('team7');
    const loaded = new Game('team7', JSON.parse(JSON.stringify(g.toSave())));
    expect(loaded.team.intern()!.name).toBe(e.name);
    expect(loaded.notes.find((n) => n.runbook)?.runbook?.triggers).toContain('my desk');
  });
});
