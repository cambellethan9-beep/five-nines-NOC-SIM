import { describe, expect, it } from 'vitest';
import { buildOffice } from '../src/content/office';
import { Breakage, BREAKAGE_MIX, wearingLinks } from '../src/game/breakage';
import { replaceNic } from '../src/game/desk';
import { FAULTS, faultById } from '../src/game/faults';
import { Game } from '../src/game/game';
import { generatedTemplate, planGenerated, planHardware } from '../src/game/generator';
import type { TicketQueue } from '../src/game/queue';
import type { Network } from '../src/sim/network';
import { Rng } from '../src/sim/rng';
import { CliSession } from '../src/sim/cli/session';

const SHIFT = 60 * 60_000;
const ctxFor = (seed: string) => {
  const office = buildOffice(seed);
  return { net: office.net, office, rng: new Rng(seed), busyPcs: new Set([office.tutorial.pcId]), activeTemplates: new Set<string>(), usedTemplates: new Set<string>() };
};

describe('hardware breakage', () => {
  it('the ticket generator never picks worn-out hardware', () => {
    const hardware = new Set(FAULTS.filter((f) => f.hardware).map((f) => f.id));
    expect([...hardware].sort()).toEqual(['cable-bad', 'infra-cable', 'nic-dead', 'port-dead']);
    for (let i = 0; i < 60; i++) {
      const ctx = ctxFor(`nohw-${i}`);
      const p = planGenerated(ctx, (['trivial', 'easy', 'moderate', 'hard', 'expert'] as const)[i % 5], i % 5);
      if (!p) continue;
      for (const a of JSON.parse(String(p.atoms))) expect(hardware.has(a.id)).toBe(false);
    }
  });

  it('every kind in the mix can really happen in the office', () => {
    for (const m of BREAKAGE_MIX) {
      const ctx = ctxFor(`mix-${m.fault}`);
      const params = planHardware(ctx, m.fault);
      expect(params, m.fault).not.toBeNull();
      const draft = generatedTemplate.build(ctx, params!);
      draft.inject();
      expect(draft.check()).toBe(false);
      const site = JSON.parse(String(params!.atoms))[0].site;
      expect(faultById(m.fault).repaired!(ctx.net, site)).toBe(false);
      draft.fix();
      expect(faultById(m.fault).repaired!(ctx.net, site)).toBe(true);
      expect(draft.check()).toBe(true);
    }
  });

  it('a dead NIC: Device Manager shows it, a new cable does nothing, a new card fixes it', () => {
    const ctx = ctxFor('nic');
    const params = planHardware(ctx, 'nic-dead')!;
    const draft = generatedTemplate.build(ctx, params);
    draft.inject();
    const pc = ctx.net.device(String(params.pcId));
    expect(pc.nic!.failed).toBe(true);
    const peer = ctx.net.peerOf(pc.id, 'FastEthernet0')!;
    expect(ctx.net.isUp(peer.device, peer.iface)).toBe(false);
    ctx.net.linkAt(peer.device, peer.iface)!.cable = 'ok';
    ctx.net.commit();
    expect(ctx.net.isUp(peer.device, peer.iface)).toBe(false);
    replaceNic(ctx.net, pc);
    expect(ctx.net.isUp(peer.device, peer.iface)).toBe(true);
  });

  it('a dead switch port: moving the cable to a free port and configuring it the same fixes it', () => {
    const ctx = ctxFor('port');
    const params = planHardware(ctx, 'port-dead')!;
    const draft = generatedTemplate.build(ctx, params);
    draft.inject();
    expect(draft.check()).toBe(false);
    const site = JSON.parse(String(params.atoms))[0].site;
    const sw = ctx.net.device(site.sw);
    // A new cable in the same dead port doesn't help.
    ctx.net.linkAt(site.sw, site.port)!.cable = 'ok';
    ctx.net.commit();
    expect(ctx.net.isUp(site.sw, site.port)).toBe(false);
    const free = Object.keys(sw.hardware).find((p) => p.startsWith('FastEthernet') && !ctx.net.linkAt(sw.id, p) && !sw.deadPorts?.includes(p))!;
    // Move it, then configure the new port like a player would.
    ctx.net.disconnect(String(params.pcId), 'FastEthernet0');
    ctx.net.connect(String(params.pcId), 'FastEthernet0', sw.id, free);
    const cli = new CliSession(ctx.net, sw.id);
    for (const line of ['enable', 'configure terminal', `interface ${free}`, 'switchport mode access', 'switchport access vlan 10', 'spanning-tree portfast', 'no shutdown', 'end']) cli.input(line);
    ctx.net.commit();
    expect(ctx.net.isUp(sw.id, free)).toBe(true);
    expect(faultById('port-dead').repaired!(ctx.net, site)).toBe(true);
  });

  it('failures come at a realistic rate: about one every 6-7 shifts in the office, mostly cables', () => {
    const office = buildOffice('rate');
    const links = wearingLinks(office.net);
    expect(links).toBeGreaterThan(20);
    expect(links).toBeLessThan(45);
    const fakeNet = office.net as unknown as { time: number } & Network;
    const ctx = { net: office.net, office, rng: new Rng('rate'), busyPcs: new Set<string>(), activeTemplates: new Set<string>(), usedTemplates: new Set<string>() };
    const queue = { context: () => ctx, startGenerated: () => true } as unknown as TicketQueue;
    const b = new Breakage('clock');
    const shifts = 2000;
    for (let t = 0; t < shifts * SHIFT; t += 60_000) {
      fakeNet.time = t;
      b.update(fakeNet, queue, Math.floor(t / SHIFT) + 1);
    }
    const perShift = b.log.length / shifts;
    expect(perShift).toBeGreaterThan(0.1);
    expect(perShift).toBeLessThan(0.22);
    const cables = b.log.filter((x) => x.fault === 'cable-bad' || x.fault === 'infra-cable').length / b.log.length;
    expect(cables).toBeGreaterThan(0.85);
    const ports = b.log.filter((x) => x.fault === 'port-dead').length / b.log.length;
    expect(ports).toBeLessThan(0.07);
    const st = b.stats();
    expect(st.mtbf! / SHIFT).toBeGreaterThan(4);
    expect(st.mtbf! / SHIFT).toBeLessThan(10);
  });

  it('a failure in a real game opens a ticket, and repair time is logged', () => {
    const game = new Game('hw-game');
    game.introPending = false;
    game.queue.tickets[0].draft.fix();
    game.queue.resolve('INC-1001', 'fixed');
    game.notifyUser('INC-1001', 'direct');
    game.breakage.nextAt = game.net.time + 1000;
    game.tick(5000);
    expect(game.breakage.log.length).toBe(1);
    const b = game.breakage.log[0];
    game.tick(5 * 60_000);
    const t = game.queue.tickets.find((x) => x.draft.params.hardware);
    expect(t).toBeTruthy();
    t!.draft.fix();
    game.tick(30_000);
    expect(b.fixedAt).not.toBeNull();
    expect(game.breakage.stats().mttr).toBeGreaterThan(0);
    // Saved and loaded: the log and the clock survive.
    const again = new Game(game.seed, JSON.parse(JSON.stringify(game.toSave())));
    expect(again.breakage.log.length).toBe(1);
  });
});
