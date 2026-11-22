import { describe, expect, it } from 'vitest';
import { deskStatus, lookBehind, reseatCable, replaceCable, setAdapterEnabled, updateDriver } from '../src/game/desk';
import { buildOffice } from '../src/content/office';

function pcOf() {
  const office = buildOffice('desk');
  const pc = office.net.device('ws03');
  pc.powered = true;
  office.net.commit({ silent: true });
  return { net: office.net, pc };
}

describe('desk visit actions', () => {
  it('an unplugged cable is visible behind the desk and fixed by reseating', () => {
    const { net, pc } = pcOf();
    net.linkAt(pc.id, 'FastEthernet0')!.cable = 'unplugged';
    net.commit();
    expect(deskStatus(net, pc)).toBe('unplugged');
    expect(lookBehind(net, pc)).toMatchObject({ cableInNic: false, linkLight: false });
    expect(reseatCable(net, pc)).toMatch(/plugged the cable back/);
    expect(deskStatus(net, pc)).toBe('connected');
    expect(lookBehind(net, pc).linkLight).toBe(true);
  });

  it('a damaged cable survives a reseat but not a replacement', () => {
    const { net, pc } = pcOf();
    net.linkAt(pc.id, 'FastEthernet0')!.cable = 'cut';
    net.commit();
    expect(lookBehind(net, pc).cableNote).toMatch(/crushed/);
    expect(reseatCable(net, pc)).toMatch(/stays off/);
    expect(deskStatus(net, pc)).toBe('disconnected');
    replaceCable(net, pc);
    expect(deskStatus(net, pc)).toBe('connected');
  });

  it("automatic driver search fails without internet; the toolkit USB works", () => {
    const { net, pc } = pcOf();
    pc.nic!.driver = 'outdated';
    net.commit();
    expect(deskStatus(net, pc)).toBe('disconnected');
    expect(updateDriver(net, pc, 'auto')).toMatch(/couldn't search online/);
    expect(updateDriver(net, pc, 'usb')).toMatch(/successfully updated/);
    expect(deskStatus(net, pc)).toBe('connected');
  });

  it('a missing driver hides the adapter entirely', () => {
    const { net, pc } = pcOf();
    pc.nic!.driver = 'missing';
    net.commit();
    expect(deskStatus(net, pc)).toBe('no-adapter');
    updateDriver(net, pc, 'usb');
    expect(deskStatus(net, pc)).toBe('connected');
  });

  it('a disabled adapter comes back when enabled', () => {
    const { net, pc } = pcOf();
    setAdapterEnabled(net, pc, false);
    expect(deskStatus(net, pc)).toBe('no-adapter');
    setAdapterEnabled(net, pc, true);
    expect(deskStatus(net, pc)).toBe('connected');
  });

  it('the wall jack label tells you the switch port', () => {
    const { net, pc } = pcOf();
    expect(lookBehind(net, pc).jackLabel).toBe('CR-ACC1 Fa0/3');
  });
});

describe('network settings panel', () => {
  it('fixes a wrong static gateway by switching back to DHCP', async () => {
    const { Game } = await import('../src/game/game');
    const { applyIpSettings, currentIpSettings } = await import('../src/game/desk');
    const game = new Game('gw');
    game.queue.tickets[0].draft.fix();
    game.queue.startTemplate('wrong-gateway', 0);
    game.tick(5_000);
    const t = game.queue.tickets.find((x) => x.draft.templateId === 'wrong-gateway')!;
    const pc = game.net.device(t.draft.reporter.pcId);
    pc.powered = true;
    game.net.commit({ silent: true });
    const before = currentIpSettings(pc);
    expect(before.dhcp).toBe(false);
    expect(before.gateway).toBe('10.10.10.254');
    expect(game.queue.resolve(t.id, '').ok).toBe(false);
    expect(applyIpSettings(game.net, pc, { ...before, dhcp: true, dns: '' })).toMatch(/Got 10\.10\.10\.\d+ from 10\.10\.20\.10/);
    expect(game.queue.resolve(t.id, 'back to DHCP').ok).toBe(true);
  });

  it('validates input like Windows, and warns about an off-subnet gateway', async () => {
    const { applyIpSettings } = await import('../src/game/desk');
    const { net, pc } = pcOf();
    pc.hostNet = { dhcp: true, lease: null, apipa: false, dnsServer: null, dnsCache: {} };
    expect(applyIpSettings(net, pc, { dhcp: false, ip: '10.10.10.300', mask: '255.255.255.0', gateway: '', dns: '' })).toMatch(/IP address you entered is not valid/);
    expect(applyIpSettings(net, pc, { dhcp: false, ip: '10.10.10.103', mask: '255.0.255.0', gateway: '', dns: '' })).toMatch(/subnet mask/);
    expect(applyIpSettings(net, pc, { dhcp: false, ip: '10.10.10.103', mask: '255.255.255.0', gateway: '10.10.20.1', dns: '' })).toMatch(/not on the same network segment/);
  });
});
