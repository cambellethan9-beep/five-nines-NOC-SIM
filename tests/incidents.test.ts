import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game';
import { run } from './helpers';

const MIN = 60_000;

/** A game past the tutorial with one office-wide fault injected and not yet reported. */
function withFault(): Game {
  const g = new Game('inc');
  g.introPending = false;
  run(g.net, 'acc1', ['en', 'conf t', 'int fa0/7', 'no shut', 'end']);
  g.queue.resolve(g.queue.tickets[0].id, 'port was shut');
  expect(g.queue.startTemplate('default-route', 2 * MIN)).toBe(true);
  return g;
}

describe('NOC-declared incidents', () => {
  it('a report that comes in after you declared is linked and counts as acknowledged', () => {
    const g = withFault();
    const inc = g.declareIncident('Internet down office-wide', 1, 'Monitor: CR-RTR1');
    g.tick(3 * MIN);
    const t = g.queue.tickets.find((x) => x.draft.templateId === 'default-route')!;
    expect(t).toBeDefined();
    expect(inc.linked).toContain(t.id);
    expect(t.respondedAt).not.toBeNull();
    expect(t.activity.some((a) => a.text.includes(`Linked by the service desk to ${inc.id}`))).toBe(true);
  });

  it('resolving the incident resolves the linked tickets (checked against the network) and writes a review note', () => {
    const g = withFault();
    const inc = g.declareIncident('Internet down', 1);
    g.tick(3 * MIN);
    // Not fixed yet: the linked ticket fails its check.
    const notFixed = g.resolveIncident(inc.id, { cause: 'x', fix: 'y', prevention: '' }, { closeLinked: true, toNotebook: false });
    expect(notFixed[0].ok).toBe(false);
    const g2 = withFault();
    const inc2 = g2.declareIncident('Internet down', 1);
    g2.tick(3 * MIN);
    run(g2.net, 'rtr1', ['en', 'conf t', 'ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'end']);
    const r = g2.resolveIncident(inc2.id, { cause: 'Static default removed on CR-RTR1', fix: 'Put it back', prevention: 'Change control' }, { closeLinked: true, toNotebook: true });
    expect(r.every((x) => x.ok)).toBe(true);
    expect(g2.incidents.find(inc2.id)!.status).toBe('resolved');
    expect(g2.notes[0].title).toBe(`${inc2.id} review: Internet down`);
    expect(g2.notes[0].body).toContain('# Root cause\nStatic default removed on CR-RTR1');
  });

  it('survives a save and load', () => {
    const g = withFault();
    const inc = g.declareIncident('Something odd', 3);
    g.incidents.update(inc.id, g.net.time, 'Looking at CR-ACC2', 'identified');
    const loaded = new Game('inc', JSON.parse(JSON.stringify(g.toSave())));
    const back = loaded.incidents.find(inc.id)!;
    expect(back.status).toBe('identified');
    expect(back.timeline.at(-1)!.text).toBe('Looking at CR-ACC2');
  });
});

describe('achievements', () => {
  it('lifetime titles, a feat, and they survive a save', () => {
    const g = withFault();
    g.queue.lifetimePoints = 1200;
    g.tick(1000);
    expect(g.achievements.has('pts-1k')).toBe(true);
    expect(g.achievements.has('first-ticket')).toBe(true);
    expect(g.achievements.title()).toBe('The Okayest Intern Ever');
    expect(g.achievements.fresh.map((a) => a.id)).toContain('pts-1k');
    const loaded = new Game('inc', JSON.parse(JSON.stringify(g.toSave())));
    expect(loaded.achievements.has('pts-1k')).toBe(true);
    expect(loaded.achievements.fresh).toEqual([]);
  });

  it('Saw It Coming: declared before the report', () => {
    const g = withFault();
    g.declareIncident('Internet down', 1);
    g.tick(3 * MIN);
    expect(g.achievements.has('saw-it-coming')).toBe(true);
  });
});
