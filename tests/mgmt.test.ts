import { describe, expect, it } from 'vitest';
import { buildOffice } from '../src/content/office';
import { Game } from '../src/game/game';
import { HostShell } from '../src/sim/host';
import { run } from './helpers';

describe('syslog to the NOC', () => {
  it('the predecessor set up syslog on everything except the replacement CR-ACC2', () => {
    const { net } = buildOffice();
    run(net, 'acc1', ['en', 'conf t', 'int fa0/22', 'shut', 'end']);
    run(net, 'acc2', ['en', 'conf t', 'int fa0/22', 'shut', 'end']);
    const seen = net.logs.filter((l) => l.collected !== false && l.message.includes('FastEthernet0/22'));
    expect(seen.map((l) => l.device)).toEqual(['acc1']);
    expect(run(net, 'acc1', ['en', 'sh run | i ^logging|^snmp|^ntp'])).toContain('logging host 10.10.99.50\nsnmp-server community cedar-mon RO');
    expect(run(net, 'acc2', ['en', 'sh run | i ^logging|^snmp|^ntp'])).not.toContain('logging host');
  });

  it('logging host and trap level decide what arrives; the path has to be open too', () => {
    const { net } = buildOffice();
    run(net, 'acc2', ['en', 'conf t', 'logging host 10.10.99.50', 'logging trap warnings', 'end']);
    net.log('acc2', '%LINK-3-UPDOWN: Interface FastEthernet0/9, changed state to down');
    net.log('acc2', '%LINEPROTO-5-UPDOWN: Line protocol on Interface FastEthernet0/9, changed state to down');
    const last = net.logs.slice(-2);
    expect(last.map((l) => l.collected)).toEqual([true, false]);
    // CR-RTR1's logs are routed through the core, so an ACL there can drop them (CR-ACC2 shares VLAN 99 with the NOC).
    net.log('rtr1', '%LINK-3-UPDOWN: Interface GigabitEthernet0/2, changed state to down');
    expect(net.logs.at(-1)!.collected).toBe(true);
    run(net, 'core1', ['en', 'conf t', 'access-list 150 deny udp any any eq syslog', 'access-list 150 permit ip any any', 'int vlan 99', 'ip access-group 150 out', 'end']);
    net.log('rtr1', '%LINK-3-UPDOWN: Interface GigabitEthernet0/2, changed state to up');
    expect(net.logs.at(-1)!.collected).toBe(false);
  });

  it('show logging lists the trap destination and the buffer', () => {
    const { net } = buildOffice();
    run(net, 'acc1', ['en', 'conf t', 'int fa0/22', 'shut', 'end']);
    const out = run(net, 'acc1', ['en', 'show logging']);
    expect(out).toContain('    Trap logging: level informational');
    expect(out).toContain('        Logging to 10.10.99.50  (udp port 514, audit disabled,\n              link up),');
    expect(out).toContain('Log Buffer (16384 bytes):');
    expect(out).toContain('%LINK-5-CHANGED: Interface FastEthernet0/22, changed state to administratively down');
  });
});

describe('clocks, timestamps and NTP', () => {
  it('synced devices show the real time; CR-ACC2 runs on its 1993 boot clock with a *', () => {
    const { net } = buildOffice();
    expect(run(net, 'core1', ['show clock'])).toMatch(/\n\d\d:\d\d:\d\d\.\d{3} UTC Tue Apr 14 2026/);
    expect(run(net, 'acc2', ['show clock'])).toMatch(/\n\*\d\d:\d\d:\d\d\.\d{3} UTC Mon Mar 1 1993/);
    expect(run(net, 'core1', ['show ntp status'])).toContain('Clock is synchronized, stratum 3, reference is 10.10.20.10');
    expect(run(net, 'acc2', ['show ntp status'])).toContain('Clock is unsynchronized, stratum 16, no reference clock');
    run(net, 'acc2', ['en', 'conf t', 'ntp server 10.10.20.10', 'end']);
    expect(run(net, 'acc2', ['show clock'])).toMatch(/\n\d\d:\d\d:\d\d\.\d{3} UTC Tue Apr 14 2026/);
    expect(run(net, 'acc2', ['show ntp associations'])).toMatch(/\*~10\.10\.20\.10\s+\.GPS\.\s+2/);
  });

  it('log stamps follow service timestamps and the clock', () => {
    const { net } = buildOffice();
    net.log('acc2', '%SYS-5-CONFIG_I: Configured from console by console');
    expect(net.logs.at(-1)!.stamp).toMatch(/^\*Mar  1 \d\d:\d\d:\d\d\.\d{3}$/);
    run(net, 'acc1', ['en', 'conf t', 'service timestamps log uptime', 'end']);
    expect(net.logs.at(-1)!.stamp).toMatch(/^\d\d:\d\d:\d\d$|^\d+d\d\dh$/);
    run(net, 'acc1', ['en', 'conf t', 'no service timestamps log', 'end']);
    expect(net.logs.at(-1)!.stamp).toBe('');
    expect(run(net, 'acc1', ['en', 'sh run | i timestamps'])).toContain('no service timestamps log');
  });

  it('clock set fixes the time until a reload; ntp master makes a router a time source', () => {
    const { net } = buildOffice();
    run(net, 'acc2', ['en', 'clock set 09:30:00 14 Apr 2026']);
    expect(run(net, 'acc2', ['show clock'])).toMatch(/\n09:30:\d\d\.\d{3} UTC Tue Apr 14 2026/);
    run(net, 'rtr1', ['en', 'conf t', 'no ntp server 10.10.20.10', 'ntp master 4', 'end']);
    expect(run(net, 'rtr1', ['show ntp status'])).toContain('Clock is synchronized, stratum 4, reference is 127.127.1.1');
  });
});

describe('SNMP and the Monitor tab', () => {
  it('the poller sees devices with the right community, through any ACL, over an open path', () => {
    const game = new Game('snmp');
    const dev = (id: string) => game.net.device(id);
    expect(game.snmpOk(dev('acc1'))).toBe(true);
    expect(game.snmpOk(dev('acc2'))).toBe(false);
    run(game.net, 'acc2', ['en', 'conf t', 'snmp-server community public RO', 'end']);
    expect(game.snmpOk(dev('acc2'))).toBe(false);
    run(game.net, 'acc2', ['en', 'conf t', 'access-list 20 permit 10.10.10.0 0.0.0.255', 'snmp-server community cedar-mon RO 20', 'end']);
    expect(game.snmpOk(dev('acc2'))).toBe(false);
    run(game.net, 'acc2', ['en', 'conf t', 'access-list 20 permit host 10.10.99.50', 'end']);
    expect(game.snmpOk(dev('acc2'))).toBe(true);
    expect(run(game.net, 'acc2', ['en', 'show snmp community'])).toContain('Community name: cedar-mon');
  });

  it('SNMPv3 groups and users', () => {
    const { net } = buildOffice();
    const out = run(net, 'core1', ['en', 'conf t', 'snmp-server group NOC v3 priv', 'snmp-server user noc NOC v3 auth sha S3cret!x priv aes 128 Pr1vate!y', 'end', 'show snmp user']);
    expect(out).toContain('User name: noc');
    expect(out).toContain('Authentication Protocol: SHA\nPrivacy Protocol: AES128\nGroup-name: NOC');
    expect(run(net, 'core1', ['en', 'sh run | i snmp-server'])).toContain('snmp-server group NOC v3 priv');
    expect(run(net, 'core1', ['en', 'show running-config']).split('\n').some((l) => l.startsWith('snmp-server user'))).toBe(false); // IOS never shows users
  });

  it('the console prints log lines with the device stamp and respects logging console', () => {
    const { net } = buildOffice();
    const sh = new HostShell(net, 'noc');
    void sh;
    const out = run(net, 'acc1', ['en', 'conf t', 'logging console warnings', 'int fa0/22', 'shut', 'end']);
    expect(out).not.toContain('%LINK-5-CHANGED');
  });
});
