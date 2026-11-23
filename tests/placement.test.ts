import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game';
import { PLACEMENT_STEPS, STEP_MS, placedRank } from '../src/game/placement';

describe('placement shift', () => {
  it('up to three at once like a Network Engineer shift; solving all five quickly places you at Network Engineer', () => {
    const g = new Game('place');
    g.introPending = false;
    g.startPlacement();
    expect(g.inPlacement).toBe(true);
    expect(g.queue.openTickets().length).toBe(0); // Owen took the tutorial
    expect(g.shiftStart).toBe(Infinity);
    expect(g.placement!.current.length).toBe(1);
    g.tick(5 * 60_000);
    expect(g.placement!.current.length).toBe(3); // the rest trickled in
    let guard = 0;
    while (!g.placement!.state.done && guard++ < 20) {
      // Tickets in play at the same time can hide each other (an outage masks a desk fault): fix them all.
      const open = g.placement!.current;
      for (const c of open) expect(c.draft.check()).toBe(false); // really broken
      g.tick(5_000);
      for (const c of open) c.draft.fix();
      for (const c of open) expect(g.placement!.check(c.index)).toBe(true);
      expect(g.placement!.current.length).toBeLessThanOrEqual(3);
      g.tick(120_000); // the next ones arrive
    }
    expect(g.placement!.state.done).toBe(true);
    expect(g.placement!.score).toBeGreaterThanOrEqual(900);
    expect(g.placement!.state.results.every((r) => r.solved)).toBe(true);
    expect(g.placement!.state.placedRank).toBe(2);
    g.finishPlacement();
    expect(g.queue.rankIndex).toBe(2);
    expect(g.started).toBe(true);
    expect(g.queue.lifetimePoints).toBe(0);
    g.tick(1000);
    expect(g.achievements.has('placed')).toBe(true);
  });

  it('bands: 600 for Tier 2, 900 for Network Engineer', () => {
    const r = (points: number) => ({ index: 0, templateId: 'x', difficulty: 'easy' as const, solved: true, ms: 0, points });
    expect(placedRank([r(599)])).toBe(0);
    expect(placedRank([r(600)])).toBe(1);
    expect(placedRank([r(899)])).toBe(1);
    expect(placedRank([r(900)])).toBe(2);
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
    g.tick(5 * 60_000);
    const first = g.placement!.current[0];
    first.draft.fix();
    g.placement!.check(first.index);
    const subjects = g.placement!.current.map((c) => c.draft.subject);
    const loaded = new Game('place3', JSON.parse(JSON.stringify(g.toSave())));
    expect(loaded.inPlacement).toBe(true);
    expect(loaded.placement!.current.map((c) => c.draft.subject)).toEqual(subjects);
    expect(loaded.placement!.current[0].draft.check()).toBe(false);
  });
});

describe('physical layer', () => {
  it('unplug at the switch, carry the cable, plug into another port; labels are physical', () => {
    const g = new Game('phys');
    g.introPending = false;
    const port = g.net.peerOf('ws03', 'FastEthernet0')!.iface;
    expect(g.net.device('acc1').portLabels![port]).toMatch(/^Desk 1-/);
    expect(g.unplugPort('acc1', port)).toContain('have to be at the switch');
    g.walkTo('acc1');
    expect(g.unplugPort('acc1', port)).toContain('Unplugged');
    expect(g.net.linkAt('ws03', 'FastEthernet0')).toBeUndefined();
    expect(g.plugPort('acc1', 'FastEthernet0/15')).toContain('Plugged');
    expect(g.net.peerOf('ws03', 'FastEthernet0')!.iface).toBe('FastEthernet0/15');
    g.setPortLabel('acc1', 'FastEthernet0/15', 'Desk 1-03 (temp)');
    expect(g.net.device('acc1').portLabels!['FastEthernet0/15']).toBe('Desk 1-03 (temp)');
    // A config change doesn't touch the label.
    expect(g.net.device('acc1').running.interfaces['FastEthernet0/15'].description ?? null).not.toBe('Desk 1-03 (temp)');
  });

  it('printer panel: reseat the cable and update the firmware (it reboots)', () => {
    const g = new Game('phys2');
    g.introPending = false;
    g.net.linkAt('prn1', 'FastEthernet0')!.cable = 'unplugged';
    g.net.commit();
    g.walkTo('prn1');
    expect(g.reseatPrinterCable('prn1')).toContain('link light comes on');
    expect(g.updatePrinterFirmware('prn1')).toContain('offline for about 2 minutes');
    expect(g.net.isOnline(g.net.device('prn1'))).toBe(false);
    g.tick(125_000);
    expect(g.net.isOnline(g.net.device('prn1'))).toBe(true);
  });
});
