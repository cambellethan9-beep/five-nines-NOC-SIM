import { describe, expect, it } from 'vitest';
import { formatIp, maskToPrefix, parseIp, prefixToMask } from '../src/sim/ip';
import { Rng } from '../src/sim/rng';
import { canReach, ping, traceroute } from '../src/sim/routing';
import { canPing, demo, run } from './helpers';

describe('ip helpers', () => {
  it('parses and formats addresses', () => {
    expect(formatIp(parseIp('192.168.1.254')!)).toBe('192.168.1.254');
    expect(parseIp('256.1.1.1')).toBeNull();
    expect(parseIp('1.2.3')).toBeNull();
  });
  it('converts masks', () => {
    expect(maskToPrefix(parseIp('255.255.255.252')!)).toBe(30);
    expect(maskToPrefix(parseIp('255.0.255.0')!)).toBeNull();
    expect(formatIp(prefixToMask(20))).toBe('255.255.240.0');
  });
});

describe('seeded rng', () => {
  it('replays the same sequence for the same seed', () => {
    const a = new Rng('scenario-42');
    const b = new Rng('scenario-42');
    expect([a.next(), a.int(1, 100), a.pick(['x', 'y', 'z'])]).toEqual([b.next(), b.int(1, 100), b.pick(['x', 'y', 'z'])]);
  });
});

describe('demo network', () => {
  it('starts with the tutorial fault: PC1 is cut off, PC2 works', () => {
    const net = demo();
    expect(net.state('sw1', 'FastEthernet0/1').link).toBe('admin-down');
    expect(canPing(net, 'pc1', '10.20.1.10')).toBe(false);
    expect(canPing(net, 'pc2', '10.20.1.10')).toBe(true);
  });

  it('no shutdown on SW1 Fa0/1 fixes PC1 and logs IOS messages', () => {
    const net = demo();
    run(net, 'sw1', ['enable', 'conf t', 'int fa0/1', 'no shut', 'end']);
    expect(canPing(net, 'pc1', '10.20.1.10')).toBe(true);
    const messages = net.logs.filter((l) => l.device === 'sw1').map((l) => l.message);
    expect(messages).toContain('%LINK-3-UPDOWN: Interface FastEthernet0/1, changed state to up');
    expect(messages).toContain('%LINEPROTO-5-UPDOWN: Line protocol on Interface FastEthernet0/1, changed state to up');
    expect(messages).toContain('%SYS-5-CONFIG_I: Configured from console by console');
  });

  it('first ping loses one packet to ARP, then succeeds', () => {
    const net = demo();
    expect(ping(net, 'pc2', parseIp('10.20.1.10')!).marks).toBe('.!!!!');
    expect(ping(net, 'pc2', parseIp('10.20.1.10')!).marks).toBe('!!!!!');
  });

  it('canReach checks the outcome without touching ARP caches', () => {
    const net = demo();
    expect(canReach(net, 'pc2', parseIp('10.20.1.10')!)).toBe(true);
    expect(canReach(net, 'pc1', parseIp('10.20.1.10')!)).toBe(false);
    expect(net.device('pc2').arp.size).toBe(0);
  });

  it('traceroute shows each router hop', () => {
    const net = demo();
    const hops = traceroute(net, 'pc2', parseIp('10.20.1.10')!).map((h) => (h.address === null ? null : formatIp(h.address)));
    expect(hops).toEqual(['10.10.20.1', '10.0.12.2', '10.20.1.10']);
  });

  it('a missing route on R1 gives U.U.U from downstream and dots from R1 itself', () => {
    const net = demo();
    run(net, 'r1', ['en', 'conf t', 'no ip route 10.20.0.0 255.255.0.0', 'end']);
    expect(ping(net, 'pc2', parseIp('10.20.1.10')!).marks).toBe('U.U.U');
    expect(ping(net, 'r1', parseIp('10.20.1.10')!).marks).toBe('.....');
  });

  it('a missing return route breaks ping even though the forward path works', () => {
    const net = demo();
    run(net, 'r2', ['en', 'conf t', 'no ip route 0.0.0.0 0.0.0.0', 'end']);
    expect(canPing(net, 'pc2', '10.20.1.10')).toBe(false);
    expect(canPing(net, 'r1', '10.0.12.2')).toBe(true);
  });

  it('removing a VLAN from the trunk cuts off that VLAN only', () => {
    const net = demo();
    run(net, 'sw1', ['en', 'conf t', 'int g0/1', 'switchport trunk allowed vlan 1,10', 'end']);
    run(net, 'sw1', ['en', 'conf t', 'int fa0/1', 'no shut', 'end']);
    expect(canPing(net, 'pc2', '10.10.20.1')).toBe(false);
    expect(canPing(net, 'pc1', '10.10.10.1')).toBe(true);
  });

  it('a wrong access VLAN isolates the PC', () => {
    const net = demo();
    run(net, 'sw1', ['en', 'conf t', 'int fa0/2', 'switchport access vlan 10', 'end']);
    expect(canPing(net, 'pc2', '10.10.20.1')).toBe(false);
  });

  it('DTP: dynamic auto on both ends stays access, so the trunk breaks', () => {
    const net = demo();
    run(net, 'sw1', ['en', 'conf t', 'int g0/1', 'switchport mode dynamic auto', 'end']);
    // The router side is not a switchport, so the port becomes access in VLAN 1: subinterfaces lose their VLANs.
    expect(canPing(net, 'pc2', '10.10.20.1')).toBe(false);
  });

  it('a cut cable takes both ends down', () => {
    const net = demo();
    net.linkAt('r1', 'GigabitEthernet0/1')!.cable = 'cut';
    net.commit();
    expect(net.state('r1', 'GigabitEthernet0/1')).toEqual({ link: 'down', protocol: 'down' });
    expect(net.state('r2', 'GigabitEthernet0/1')).toEqual({ link: 'down', protocol: 'down' });
    expect(canPing(net, 'pc2', '10.20.1.10')).toBe(false);
  });

  it('mismatched hard-coded speeds keep the link down', () => {
    const net = demo();
    run(net, 'r1', ['en', 'conf t', 'int g0/1', 'speed 100', 'end']);
    expect(net.isUp('r1', 'GigabitEthernet0/1')).toBe(true);
    run(net, 'r2', ['en', 'conf t', 'int g0/1', 'speed 10', 'end']);
    expect(net.isUp('r1', 'GigabitEthernet0/1')).toBe(false);
  });

  it('SVI is up/up only while a port in its VLAN is active', () => {
    const net = demo();
    expect(net.state('sw1', 'Vlan10')).toEqual({ link: 'up', protocol: 'up' }); // trunk and NOC-PC port carry VLAN 10
    run(net, 'sw1', ['en', 'conf t', 'int g0/1', 'shut', 'int fa0/3', 'shut', 'end']);
    expect(net.state('sw1', 'Vlan10')).toEqual({ link: 'up', protocol: 'down' });
  });
});

describe('reload and saving', () => {
  it('unsaved changes are lost on reload; saved changes survive', () => {
    const net = demo();
    run(net, 'sw1', ['en', 'conf t', 'int fa0/1', 'no shut', 'end']);
    expect(net.isUp('sw1', 'FastEthernet0/1')).toBe(true);
    run(net, 'sw1', ['en', 'reload', 'no', '']);
    net.advance(60_000);
    expect(net.isUp('sw1', 'FastEthernet0/1')).toBe(false);

    run(net, 'sw1', ['', 'en', 'conf t', 'int fa0/1', 'no shut', 'end', 'write memory', 'reload', '']);
    net.advance(60_000);
    expect(net.isUp('sw1', 'FastEthernet0/1')).toBe(true);
  });

  it('VLANs live in vlan.dat, so they survive a reload without write memory', () => {
    const net = demo();
    run(net, 'sw1', ['en', 'conf t', 'vlan 30', 'name GUEST', 'end', 'reload', 'no', '']);
    net.advance(60_000);
    expect(net.device('sw1').vlans[30]?.name).toBe('GUEST');
  });

  it('devices are offline while booting', () => {
    const net = demo();
    run(net, 'r1', ['en', 'reload', '']);
    expect(canPing(net, 'pc2', '10.20.1.10')).toBe(false);
    net.advance(60_000);
    expect(canPing(net, 'pc2', '10.20.1.10')).toBe(true);
  });
});
