import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game';
import { canReach } from '../src/sim/routing';
import { parseIp } from '../src/sim/ip';
import { run } from './helpers';

function partnerTicket(seed = 'roas') {
  const g = new Game(seed);
  g.queue.startTemplate('partner-vlan', 0);
  g.tick(5_000);
  const t = g.queue.tickets.find((x) => x.draft.templateId === 'partner-vlan')!;
  // Floor switch side is the same either way: VLAN 50 exists and the two partner ports move into it.
  run(g.net, 'acc2', ['en', 'conf t', 'vlan 50', 'name PARTNERS', 'exit', 'int range fa0/9 - 10', 'switchport access vlan 50', 'end']);
  return { g, t };
}

describe('router-on-a-stick', () => {
  it('solves the partner VLAN change request through the spare core-to-router link (dot1Q)', () => {
    const { g, t } = partnerTicket();
    run(g.net, 'core1', ['en', 'conf t', 'vlan 50', 'name PARTNERS', 'exit', 'int fa0/23', 'switchport trunk encapsulation dot1q', 'switchport mode trunk', 'end']);
    const out = run(g.net, 'rtr1', ['en', 'conf t', 'int g0/2', 'no shut', 'int g0/2.50', 'encapsulation dot1Q 50', 'ip address 10.10.50.1 255.255.255.0', 'end']);
    expect(out).not.toContain('%');
    // Partners reach the servers now, but their internet traffic leaves untranslated until the subinterface is NAT inside.
    expect(g.queue.resolve(t.id, 'ROAS on CR-RTR1').ok).toBe(false);
    run(g.net, 'rtr1', ['en', 'conf t', 'int g0/2.50', 'ip nat inside', 'end']);
    expect(g.queue.resolve(t.id, 'ROAS on CR-RTR1, NAT inside').ok).toBe(true);
    expect(run(g.net, 'rtr1', ['en', 'show run'])).toContain('interface GigabitEthernet0/2.50\n encapsulation dot1Q 50\n ip address 10.10.50.1 255.255.255.0');
  });

  it('the core VLAN interface path still works', () => {
    const { g, t } = partnerTicket();
    run(g.net, 'core1', ['en', 'conf t', 'vlan 50', 'exit', 'int vlan 50', 'ip address 10.10.50.1 255.255.255.0', 'no shut', 'end']);
    expect(g.queue.resolve(t.id, 'SVI on CR-CORE1').ok).toBe(true);
  });

  it('a subinterface needs encapsulation before an IP, and a routed core port carries no VLANs', () => {
    const { g, t } = partnerTicket();
    expect(run(g.net, 'rtr1', ['en', 'conf t', 'int g0/0.50', 'ip address 10.10.50.1 255.255.255.0'])).toContain('only allowed if that');
    run(g.net, 'rtr1', ['en', 'conf t', 'int g0/0.50', 'encapsulation dot1Q 50', 'ip address 10.10.50.1 255.255.255.0', 'end']);
    expect(g.queue.resolve(t.id, '').ok).toBe(false); // core Fa0/24 is a routed port, not a trunk
  });
});

describe('ISL', () => {
  function islLab(coreEncap: 'isl' | 'dot1q', routerEncap: 'isl' | 'dot1Q') {
    const g = new Game('isl');
    run(g.net, 'core1', ['en', 'conf t', 'int fa0/23', `switchport trunk encapsulation ${coreEncap}`, 'switchport mode trunk', 'end']);
    run(g.net, 'rtr1', ['en', 'conf t', 'int g0/2', 'no shut', 'int g0/2.99', `encapsulation ${routerEncap} 99`, 'ip address 10.10.99.254 255.255.255.0', 'end']);
    return g;
  }

  it('ISL on both ends works', () => {
    const g = islLab('isl', 'isl');
    expect(canReach(g.net, 'rtr1', parseIp('10.10.99.50')!)).toBe(true);
    expect(run(g.net, 'core1', ['en', 'show interfaces trunk'])).toMatch(/Fa0\/23\s+on\s+isl/);
    expect(run(g.net, 'rtr1', ['en', 'show run'])).toContain('encapsulation isl 99');
  });

  it('ISL on one end and dot1Q on the other passes nothing', () => {
    expect(canReach(islLab('isl', 'dot1Q').net, 'rtr1', parseIp('10.10.99.50')!)).toBe(false);
    expect(canReach(islLab('dot1q', 'isl').net, 'rtr1', parseIp('10.10.99.50')!)).toBe(false);
    expect(canReach(islLab('dot1q', 'dot1Q').net, 'rtr1', parseIp('10.10.99.50')!)).toBe(true);
  });

  it("an access switch (NS-S2900) doesn't offer ISL", () => {
    const g = new Game('isl');
    expect(run(g.net, 'acc1', ['en', 'conf t', 'int g0/1', 'switchport trunk encapsulation isl'])).toContain("% Invalid input detected at '^' marker.");
  });

  it("can't fall back to negotiate while the port is a trunk", () => {
    const g = new Game('isl');
    expect(run(g.net, 'core1', ['en', 'conf t', 'int g0/1', 'switchport trunk encapsulation negotiate'])).toContain('Command rejected');
  });
});
