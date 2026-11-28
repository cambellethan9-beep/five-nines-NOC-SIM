import { describe, expect, it } from 'vitest';
import { ISP } from '../src/content/office';
import { FAULTS } from '../src/game/faults';
import { Game } from '../src/game/game';
import { generatedTemplate } from '../src/game/generator';
import { canReach } from '../src/sim/routing';
import { parseIp } from '../src/sim/ip';
import { CliSession } from '../src/sim/cli/session';
import { buildOffice } from '../src/content/office';
import { Rng } from '../src/sim/rng';

const MIN = 60_000;

function game(seed: string) {
  const g = new Game(seed);
  g.introPending = false;
  g.declinePlacement();
  g.queue.tickets[0].draft.fix();
  g.queue.resolve('INC-1001', 'x');
  g.notifyUser('INC-1001', 'direct');
  return g;
}

describe('native VLAN mismatch', () => {
  it('PVST+ blocks both native VLANs on the trunk, with the real logs and show output', () => {
    const office = buildOffice('nv');
    const ctx = { net: office.net, office, rng: new Rng('nv'), busyPcs: new Set<string>(), activeTemplates: new Set<string>(), usedTemplates: new Set<string>() };
    const f = FAULTS.find((x) => x.id === 'native-vlan')!;
    const site = f.sites(ctx.net, ctx.office, [])[0];
    const victims = f.victims(ctx.net, ctx.office, site);
    const draft = generatedTemplate.build(ctx, { atoms: JSON.stringify([{ id: f.id, site }]), pcId: victims[0], diff: 'hard', herring: -1, actor: -1, variant: 0 });
    draft.inject();
    expect(draft.check()).toBe(false);
    const sw = String(site.sw);
    const cli = new CliSession(ctx.net, sw);
    cli.input('enable');
    const stp = cli.input('show spanning-tree vlan 10').output.join('\n');
    expect(stp).toMatch(/Gi0\/1\s.*BKN\*.*PVID_Inc/);
    const inc = cli.input('show spanning-tree inconsistentports').output.join('\n');
    expect(inc).toContain('Port VLAN ID Inconsistent');
    const all = JSON.stringify(ctx.net.exportState());
    expect(all).toContain('%CDP-4-NATIVE_VLAN_MISMATCH');
    expect(all).toContain('%SPANTREE-2-BLOCK_PVID_LOCAL');
    draft.fix();
    expect(draft.check()).toBe(true);
  });
});

describe('ISP outage', () => {
  it("can't be fixed from inside: call the carrier with the circuit ID and wait for the ETR", () => {
    const g = game('isp');
    expect(g.queue.startTemplate('isp-outage', 0)).toBe(true);
    g.tick(5000);
    const t = g.queue.openTickets()[0];
    expect(t.draft.check()).toBe(false);
    // Our side is fine: the ISP router answers, the internet doesn't.
    // Our side is fine: the ISP's router answers ping, nothing past it does.
    expect(canReach(g.net, 'noc', parseIp(ISP.gateway)!)).toBe(true);
    expect(canReach(g.net, 'noc', parseIp('8.8.8.8')!)).toBe(false);
    expect(g.callCarrier('BLF-00000-XX')).toContain("can't find a circuit");
    const reply = g.callCarrier(ISP.circuit.toLowerCase());
    expect(reply).toContain('fiber cut');
    expect(g.carrier?.restoreAt).toBeGreaterThan(g.net.time);
    g.tick(50 * MIN);
    expect(t.draft.check()).toBe(true);
    expect(t.activity.some((a) => a.text.includes('service restored'))).toBe(true);
    expect(g.queue.resolve(t.id, 'carrier fixed').ok).toBe(true);
  });

  it('calling with nothing wrong on their side costs you time on hold', () => {
    const g = game('isp2');
    const before = g.net.time;
    expect(g.callCarrier(ISP.circuit)).toContain('tests clean');
    expect(g.net.time - before).toBeGreaterThanOrEqual(10 * MIN);
  });
});

describe('NTP drift', () => {
  it('the switch clock is off until NTP points at the right server', () => {
    const g = game('ntp');
    expect(g.queue.startTemplate('ntp-drift', 0)).toBe(true);
    g.tick(5000);
    const t = g.queue.openTickets()[0];
    expect(t.draft.check()).toBe(false);
    const cli = g.session('acc1');
    for (const l of ['enable']) cli.input(l);
    const clock = cli.input('show clock').output.join('\n');
    const core = g.session('core1');
    core.input('enable');
    expect(clock).not.toBe(core.input('show clock').output.join('\n'));
    for (const l of ['configure terminal', 'no ntp server 10.10.20.15', 'ntp server 10.10.20.10', 'end']) cli.input(l);
    g.tick(5000);
    expect(t.draft.check()).toBe(true);
  });
});
