import { describe, expect, it } from 'vitest';
import { buildOffice, NETWORK_DEVICES, PRINTERS, SERVERS } from '../src/content/office';
import { HostShell } from '../src/sim/host';
import { parseIp } from '../src/sim/ip';
import { canReach } from '../src/sim/routing';
import { Ambient } from '../src/sim/ambient';
import { interfaceRates } from '../src/sim/traffic';
import { run } from './helpers';

const reach = (net: ReturnType<typeof buildOffice>['net'], from: string, to: string) => canReach(net, from, parseIp(to)!);

describe('Cedar Ridge office', () => {
  it('has 20 staff, 4 VLANs worth of hosts and the expected gear', () => {
    const office = buildOffice();
    expect(office.people).toHaveLength(20);
    const kinds = [...office.net.devices.values()].map((d) => d.kind);
    expect(kinds.filter((k) => k === 'pc')).toHaveLength(21); // 20 staff + NOC-PC
    expect(kinds.filter((k) => k === 'printer')).toHaveLength(2);
    expect(Object.keys(office.layout).sort()).toEqual([...office.net.devices.keys()].sort());
  });

  it('every staff PC reaches servers, printers and the internet, except the tutorial PC', () => {
    const { net, tutorial } = buildOffice();
    for (const d of net.devices.values()) {
      if (d.kind !== 'pc' || d.id === 'noc') continue;
      const expected = d.id !== tutorial.pcId;
      expect(reach(net, d.id, '10.10.20.11'), `${d.id} -> FS01`).toBe(expected);
      expect(reach(net, d.id, '10.10.30.22'), `${d.id} -> PRN2`).toBe(expected);
      expect(reach(net, d.id, '8.8.8.8'), `${d.id} -> internet`).toBe(expected);
    }
  });

  it('the documented addresses are all reachable from the NOC PC', () => {
    const { net } = buildOffice();
    for (const d of NETWORK_DEVICES) expect(reach(net, 'noc', d.mgmtIp), d.hostname).toBe(true);
    for (const s of SERVERS) expect(reach(net, 'noc', s.ip), s.hostname).toBe(true);
    for (const p of PRINTERS) expect(reach(net, 'noc', p.ip), p.hostname).toBe(true);
  });

  it('the documented hostnames match the devices', () => {
    const { net } = buildOffice();
    for (const d of NETWORK_DEVICES) expect(net.device(d.id).running.hostname).toBe(d.hostname);
  });

  it('SSH from the NOC PC works on every network device with no password', () => {
    const office = buildOffice();
    for (const d of NETWORK_DEVICES) {
      const pc = new HostShell(office.net, 'noc', office.hostOptions.noc);
      pc.input(`ssh nocadmin@${d.mgmtIp}`);
      pc.input('yes');
      expect(pc.promptText(), d.hostname).toBe(`${d.hostname}#`);
    }
  });

  it('the ISP router refuses management', () => {
    const office = buildOffice();
    const pc = new HostShell(office.net, 'noc', office.hostOptions.noc);
    const r = pc.input('ssh nocadmin@203.0.113.1');
    expect(r.output.join('\n')).toContain('Connection refused');
  });

  it('traffic flows on live links and stops on dead ones', () => {
    const { net } = buildOffice();
    const uplink = interfaceRates(net, 'acc1', 'GigabitEthernet0/1');
    expect(uplink.inBps).toBeGreaterThan(0);
    expect(uplink.outBps).toBeGreaterThan(0);
    expect(interfaceRates(net, 'acc1', 'FastEthernet0/7')).toEqual({ inBps: 0, outBps: 0 }); // tutorial port is shut
    expect(interfaceRates(net, 'rtr1', 'GigabitEthernet0/1').outBps).toBeGreaterThan(0); // WAN
  });

  it('PCs fall asleep and wake up, flapping their switchports, but never the protected PC', () => {
    const { net, tutorial } = buildOffice();
    const ambient = new Ambient(net, () => new Set([tutorial.pcId]));
    for (let i = 0; i < 120; i++) {
      net.advance(30_000);
      ambient.update();
      expect(net.device(tutorial.pcId).powered).toBe(true);
    }
    const messages = net.logs.map((l) => l.message);
    expect(messages.some((m) => m.startsWith('%LINK-3-UPDOWN') && m.endsWith('down'))).toBe(true);
    expect(messages.some((m) => m.startsWith('%SNMP-3-AUTHFAIL'))).toBe(true);
  });

  it('SSH logins are logged on the device', () => {
    const office = buildOffice();
    const pc = new HostShell(office.net, 'noc', office.hostOptions.noc);
    pc.input('ssh nocadmin@10.10.99.11');
    pc.input('yes');
    const log = office.net.logs.find((l) => l.device === 'acc1' && l.message.startsWith('%SEC_LOGIN-5-LOGIN_SUCCESS'));
    expect(log?.message).toContain('[user: nocadmin] [Source: 10.10.99.50] [localport: 22]');
  });

  it('the tutorial fix works', () => {
    const { net, tutorial } = buildOffice();
    run(net, 'acc1', ['en', 'conf t', 'int fa0/7', 'no shut', 'end']);
    expect(reach(net, tutorial.pcId, '10.10.20.11')).toBe(true);
  });
});
