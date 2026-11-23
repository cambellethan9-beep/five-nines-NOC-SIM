import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game';
import { PLACEMENT_BANDS, placedRank } from '../src/game/placement';

const MIN = 60_000;

/** Plays a whole shift, fixing each ticket as it comes in (a strong player). */
function playShift(g: Game, fix: boolean): void {
  for (let i = 0; i < 70 && !g.placementResultsDue && !g.report; i++) {
    g.tick(MIN);
    if (!fix) continue;
    for (const t of g.queue.openTickets()) {
      t.draft.fix();
      g.queue.resolve(t.id, 'fixed');
      g.notifyUser(t.id, 'direct');
    }
  }
}

describe('placement shift', () => {
  it('is an ordinary shift at Network Engineer settings, with no escalation, and the score places you', () => {
    const g = new Game('place');
    g.introPending = false;
    g.startPlacement();
    expect(g.inPlacement).toBe(true);
    expect(g.queue.openTickets().length).toBe(0); // Owen took the tutorial
    expect(g.queue.rank.maxOpenTickets).toBe(3);
    playShift(g, false);
    // Let a ticket arrive and try to escalate it.
    const t = g.queue.tickets.find((x) => g.queue.isOpen(x));
    if (t) expect(g.queue.escalate(t.id, 'owen')).toContain('placement shift');
    expect(g.placementResultsDue).toBe(true);
    expect(g.placement!.score).not.toBeNull();
    // Owen cleaned up; no open tickets carry into the first real shift.
    expect(g.queue.openTickets().length).toBe(0);
    expect(g.queue.rankIndex).toBe(g.placement!.placedRank);
    expect(g.queue.lifetimePoints).toBe(0);
    g.finishPlacement();
    expect(g.placementResultsDue).toBe(false);
    expect(g.started).toBe(true);
  });

  it('a strong shift places higher than doing nothing', () => {
    const lazy = new Game('place-a');
    lazy.introPending = false;
    lazy.startPlacement();
    playShift(lazy, false);
    const good = new Game('place-a');
    good.introPending = false;
    good.startPlacement();
    playShift(good, true);
    expect(good.placement!.score!).toBeGreaterThan(lazy.placement!.score!);
    expect(good.placement!.resolved!).toBeGreaterThan(0);
    expect(good.achievements.has('placed') || good.placement!.placedRank === 0).toBe(true);
  });

  it('bands: 600 for Tier 2, 900 for Network Engineer', () => {
    expect(PLACEMENT_BANDS).toEqual({ tier2: 600, engineer: 900 });
    expect(placedRank(599)).toBe(0);
    expect(placedRank(600)).toBe(1);
    expect(placedRank(899)).toBe(1);
    expect(placedRank(900)).toBe(2);
  });

  it('a save in the middle of the placement shift resumes it', () => {
    const g = new Game('place3');
    g.introPending = false;
    g.startPlacement();
    g.tick(10 * MIN);
    const loaded = new Game('place3', JSON.parse(JSON.stringify(g.toSave())));
    expect(loaded.inPlacement).toBe(true);
    expect(loaded.queue.rankIndex).toBe(2);
    expect(loaded.queue.escalationLocked).not.toBeNull();
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
