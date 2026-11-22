import { describe, expect, it } from 'vitest';
import { buildOffice } from '../src/content/office';
import { reachService } from '../src/game/services';
import { run } from './helpers';

const office = () => {
  const o = buildOffice();
  o.net.device('ws03').powered = true;
  o.net.commit({ silent: true });
  return o;
};
const lastLogs = (net: ReturnType<typeof office>['net'], n = 20) => net.logs.slice(-n).map((l) => `${l.device}: ${l.message}`).join('\n');

describe('OSPF at HQ (the predecessor replaced the static routes)', () => {
  it('core and router are FULL; the core learns the default, the router learns every VLAN', () => {
    const { net } = office();
    expect(run(net, 'core1', ['show ip ospf neighbor'])).toMatch(/10\.255\.255\.1\s+1\s+FULL\/BDR\s+00:00:\d\d\s+10\.0\.0\.1\s+FastEthernet0\/24/);
    expect(run(net, 'core1', ['show ip route'])).toContain('O*E2  0.0.0.0/0 [110/1] via 10.0.0.1');
    expect(run(net, 'rtr1', ['show ip route'])).toMatch(/O\s+10\.10\.20\.0\/24 \[110\/2\] via 10\.0\.0\.2, \d\d:\d\d:\d\d, GigabitEthernet0\/0/);
    expect(run(net, 'rtr1', ['show ip route 10.10.20.5'])).toContain('Known via "ospf 1", distance 110, metric 2, type intra area');
    expect(reachService(net, 'ws03', '8.8.8.8')).toBe(true);
  });

  it('passive-interface default without the exception drops the adjacency and the internet', () => {
    const { net } = office();
    run(net, 'core1', ['en', 'conf t', 'router ospf 1', 'no passive-interface Fa0/24', 'passive-interface default', 'end']);
    expect(run(net, 'core1', ['show ip ospf neighbor'])).not.toContain('10.255.255.1');
    expect(lastLogs(net)).toContain('%OSPF-5-ADJCHG: Process 1, Nbr 10.255.255.1 on FastEthernet0/24 from FULL to DOWN, Neighbor Down: Interface down or detached');
    expect(lastLogs(net)).toContain('%OSPF-5-ADJCHG: Process 1, Nbr 10.255.255.2 on GigabitEthernet0/0 from FULL to DOWN, Neighbor Down: Dead timer expired');
    expect(reachService(net, 'ws03', '8.8.8.8')).toBe(false);
    run(net, 'core1', ['en', 'conf t', 'router ospf 1', 'no passive-interface fa0/24', 'end']);
    expect(lastLogs(net)).toContain('from LOADING to FULL, Loading Done');
    expect(reachService(net, 'ws03', '8.8.8.8')).toBe(true);
  });

  it('hello timer mismatch: silent, no neighbor; show ip ospf interface reveals it', () => {
    const { net } = office();
    run(net, 'rtr1', ['en', 'conf t', 'int g0/0', 'ip ospf hello-interval 5', 'end']);
    expect(run(net, 'core1', ['show ip ospf neighbor'])).not.toContain('FULL');
    expect(run(net, 'rtr1', ['show ip ospf interface g0/0'])).toContain('Timer intervals configured, Hello 5, Dead 20');
    expect(run(net, 'core1', ['show ip ospf interface fa0/24'])).toContain('Hello 10, Dead 40');
    expect(lastLogs(net)).not.toContain('ERRRCV');
  });

  it('area mismatch is logged; MTU mismatch sticks in EXSTART until mtu-ignore or matching MTUs', () => {
    const { net } = office();
    run(net, 'rtr1', ['en', 'conf t', 'router ospf 1', 'no network 10.0.0.0 0.0.0.3 area 0', 'network 10.0.0.0 0.0.0.3 area 1', 'end']);
    expect(lastLogs(net)).toContain('%OSPF-4-ERRRCV: Received invalid packet: mismatched area ID from backbone area must be virtual-link but not found from 10.0.0.1, FastEthernet0/24');
    run(net, 'rtr1', ['en', 'conf t', 'router ospf 1', 'no network 10.0.0.0 0.0.0.3 area 1', 'network 10.0.0.0 0.0.0.3 area 0', 'int g0/0', 'ip mtu 1400', 'end']);
    expect(run(net, 'core1', ['show ip ospf neighbor'])).toMatch(/EXSTART\/BDR/);
    expect(run(net, 'core1', ['show ip route'])).not.toContain('O*E2');
    // The side with the smaller MTU is the one refusing the bigger DBD packets, so that's where mtu-ignore goes.
    run(net, 'core1', ['en', 'conf t', 'int fa0/24', 'ip ospf mtu-ignore', 'end']);
    expect(run(net, 'core1', ['show ip ospf neighbor'])).toContain('EXSTART');
    run(net, 'rtr1', ['en', 'conf t', 'int g0/0', 'ip ospf mtu-ignore', 'end']);
    expect(run(net, 'core1', ['show ip ospf neighbor'])).toContain('FULL/BDR');
  });

  it('default-information originate needs a default in the router\'s table, unless always', () => {
    const { net } = office();
    run(net, 'rtr1', ['en', 'conf t', 'no ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'end']);
    expect(run(net, 'core1', ['show ip route'])).toContain('Gateway of last resort is not set');
    run(net, 'rtr1', ['en', 'conf t', 'router ospf 1', 'default-information originate always', 'end']);
    expect(run(net, 'core1', ['show ip route'])).toContain('O*E2  0.0.0.0/0');
  });

  it('redistribute static needs subnets for non-classful networks', () => {
    const { net } = office();
    const out = run(net, 'rtr1', ['en', 'conf t', 'ip route 172.20.5.0 255.255.255.0 203.0.113.1', 'ip route 192.0.2.0 255.255.255.0 203.0.113.1', 'router ospf 1', 'redistribute static', 'end']);
    expect(out).toContain('% Only classful networks will be redistributed');
    const before = run(net, 'core1', ['show ip route ospf']);
    expect(before).toContain('O E2  192.0.2.0/24 [110/20]');
    expect(before).not.toContain('172.20.5.0');
    run(net, 'rtr1', ['en', 'conf t', 'router ospf 1', 'redistribute static subnets', 'end']);
    expect(run(net, 'core1', ['show ip route ospf'])).toContain('172.20.5.0 [110/20]');
  });

  it('multi-area: an ABR makes inter-area routes; a totally stubby area only gets a default', () => {
    const { net } = office();
    // Put the core's staff VLAN in area 10 (the core becomes an ABR).
    run(net, 'core1', ['en', 'conf t', 'int vlan 10', 'ip ospf 1 area 10', 'end']);
    expect(run(net, 'rtr1', ['show ip route ospf'])).toMatch(/O IA\s+10\.10\.10\.0\/24 \[110\/2\]/);
    expect(run(net, 'core1', ['show ip ospf'])).toContain('It is an area border router');
    expect(run(net, 'core1', ['en', 'show run | i ip ospf 1 area'])).toContain('\n ip ospf 1 area 10');
  });

  it('a router-on-a-stick second path gives equal-cost routes', () => {
    const { net } = office();
    run(net, 'core1', ['en', 'conf t', 'int fa0/23', 'no switchport', 'ip address 10.0.0.6 255.255.255.252', 'no shut', 'end']);
    run(net, 'rtr1', ['en', 'conf t', 'int g0/2', 'ip address 10.0.0.5 255.255.255.252', 'no shut', 'router ospf 1', 'network 10.0.0.4 0.0.0.3 area 0', 'end']);
    run(net, 'core1', ['en', 'conf t', 'router ospf 1', 'no passive-interface fa0/23', 'network 10.0.0.4 0.0.0.3 area 0', 'end']);
    const r = run(net, 'core1', ['show ip route ospf']);
    expect(r).toMatch(/O\*E2  0\.0\.0\.0\/0 \[110\/1\] via 10\.0\.0\.[15], .*\n\s+\[110\/1\] via 10\.0\.0\.[15]/);
  });
});

describe('EIGRP', () => {
  const toEigrp = (named = false) => {
    const o = office();
    const { net } = o;
    run(net, 'rtr1', ['en', 'conf t', 'no router ospf 1', 'ip route 10.10.0.0 255.255.0.0 10.0.0.2', 'end']);
    const core = named
      ? ['en', 'conf t', 'no router ospf 1', 'router eigrp CEDAR', 'address-family ipv4 unicast autonomous-system 100', 'network 10.0.0.0 0.0.0.3', 'network 10.10.0.0 0.0.255.255', 'topology base', 'redistribute static', 'exit-af-topology', 'end']
      : ['en', 'conf t', 'no router ospf 1', 'router eigrp 100', 'network 10.0.0.0 0.0.0.3', 'network 10.10.0.0 0.0.255.255', 'end'];
    run(net, 'core1', core);
    run(net, 'rtr1', ['en', 'conf t', 'no ip route 10.10.0.0 255.255.0.0 10.0.0.2', 'router eigrp 100', 'network 10.0.0.0 0.0.0.3', 'redistribute static', 'end']);
    return o;
  };

  it('classic: neighbors, D routes with the composite metric, D EX for the redistributed default', () => {
    const { net } = toEigrp();
    expect(lastLogs(net)).toContain('%DUAL-5-NBRCHANGE: EIGRP-IPv4 100: Neighbor 10.0.0.2 (GigabitEthernet0/0) is up: new adjacency');
    expect(run(net, 'rtr1', ['show ip eigrp neighbors'])).toMatch(/0\s+10\.0\.0\.2\s+Gi0\/0/);
    // Gi0/0 runs at 100 Mb/s (the core port is FastEthernet): 256 * (10^7/100000 + 1 + 1) = 26112
    expect(run(net, 'rtr1', ['show ip route eigrp'])).toContain('D        10.10.20.0/24 [90/26112] via 10.0.0.2');
    expect(run(net, 'core1', ['show ip route'])).toMatch(/D\*EX  0\.0\.0\.0\/0 \[170\/\d+\] via 10\.0\.0\.1/);
    expect(reachService(net, 'ws03', '8.8.8.8')).toBe(true);
    expect(run(net, 'rtr1', ['show ip eigrp topology'])).toContain('P 10.10.20.0/24, 1 successors, FD is 26112');
  });

  it('K-value mismatch is logged and no adjacency forms', () => {
    const { net } = toEigrp();
    run(net, 'rtr1', ['en', 'conf t', 'router eigrp 100', 'metric weights 0 1 1 1 0 0', 'end']);
    expect(lastLogs(net)).toContain('is down: K-value mismatch');
    expect(run(net, 'rtr1', ['show ip route eigrp'])).not.toContain('10.10.20.0');
  });

  it('named mode: wide metrics, af-interface passive, and the config renders like IOS', () => {
    const { net } = toEigrp(true);
    expect(run(net, 'rtr1', ['show ip route eigrp'])).toContain('D        10.10.20.0/24 [90/26112] via 10.0.0.2');
    expect(run(net, 'core1', ['show ip route'])).toMatch(/D\*EX  0\.0\.0\.0\/0 \[170\/\d+\]/);
    run(net, 'core1', ['en', 'conf t', 'router eigrp CEDAR', 'address-family ipv4 unicast autonomous-system 100', 'af-interface default', 'passive-interface', 'exit-af-interface', 'af-interface fa0/24', 'no passive-interface', 'end']);
    const cfg = run(net, 'core1', ['en', 'sh run | s router eigrp']);
    expect(cfg).toContain('router eigrp CEDAR\n !\n address-family ipv4 unicast autonomous-system 100\n  !\n  af-interface default\n   passive-interface\n  exit-af-interface');
    expect(run(net, 'core1', ['show ip eigrp neighbors'])).toContain('VR(CEDAR) Address-Family Neighbors for AS(100)');
  });

  it('redistributing OSPF into EIGRP needs a seed metric', () => {
    const { net } = toEigrp();
    run(net, 'core1', ['en', 'conf t', 'int loopback 7', 'ip address 172.31.7.1 255.255.255.0', 'router ospf 7', 'network 172.31.7.0 0.0.0.255 area 0', 'router eigrp 100', 'redistribute ospf 7', 'end']);
    expect(run(net, 'rtr1', ['show ip route'])).not.toContain('172.31.7');
    run(net, 'core1', ['en', 'conf t', 'router eigrp 100', 'redistribute connected', 'end']);
    expect(run(net, 'rtr1', ['show ip route'])).toContain('D EX     172.31.7.0 [170/');
  });
});

describe('RIP', () => {
  it('v2 between core and router; v1 vs v2 do not talk; passive still listens', () => {
    const { net } = office();
    run(net, 'core1', ['en', 'conf t', 'no router ospf 1', 'router rip', 'version 2', 'network 10.0.0.0', 'no auto-summary', 'end']);
    run(net, 'rtr1', ['en', 'conf t', 'no router ospf 1', 'router rip', 'version 2', 'network 10.0.0.0', 'default-information originate', 'no auto-summary', 'end']);
    expect(run(net, 'rtr1', ['show ip route rip'])).toMatch(/R\s+10\.10\.20\.0\/24 \[120\/1\] via 10\.0\.0\.2/);
    expect(run(net, 'core1', ['show ip route'])).toContain('R*    0.0.0.0/0 [120/1] via 10.0.0.1');
    expect(run(net, 'core1', ['en', 'show run | s router rip'])).toContain('router rip\n version 2\n network 10.0.0.0\n no auto-summary');
    run(net, 'core1', ['en', 'conf t', 'router rip', 'version 1', 'end']);
    expect(run(net, 'core1', ['show ip route'])).not.toContain('R*');
    run(net, 'core1', ['en', 'conf t', 'router rip', 'version 2', 'passive-interface fa0/24', 'end']);
    expect(run(net, 'core1', ['show ip route'])).toContain('R*    0.0.0.0/0'); // still receives
    expect(run(net, 'rtr1', ['show ip route rip'])).not.toContain('10.10.20.0'); // but no longer sends
  });
});

describe('BGP with Brightline', () => {
  it('peering brings up the session and a default from the ISP', () => {
    const { net } = office();
    run(net, 'rtr1', ['en', 'conf t', 'router bgp 65010', 'neighbor 203.0.113.1 remote-as 64500', 'neighbor 203.0.113.1 description Brightline Fiber', 'end']);
    expect(lastLogs(net)).toContain('%BGP-5-ADJCHANGE: neighbor 203.0.113.1 Up');
    expect(run(net, 'rtr1', ['show ip bgp summary'])).toMatch(/203\.0\.113\.1\s+4\s+64500\s+\d+\s+\d+\s+\d+\s+0\s+0 \S+\s+2/);
    const table = run(net, 'rtr1', ['show ip bgp']);
    expect(table).toMatch(/\*>\s+0\.0\.0\.0\s+203\.0\.113\.1\s+0 64500 i/);
    expect(table).toMatch(/\*>\s+8\.8\.8\.0\/24\s+203\.0\.113\.1/);
    // The static default (AD 1) still wins over eBGP (20) until it's removed.
    expect(run(net, 'rtr1', ['show ip route'])).toContain('S*    0.0.0.0/0 [1/0]');
    run(net, 'rtr1', ['en', 'conf t', 'no ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'end']);
    expect(run(net, 'rtr1', ['show ip route'])).toContain('B*    0.0.0.0/0 [20/0] via 203.0.113.1');
    expect(run(net, 'core1', ['show ip route'])).toContain('O*E2  0.0.0.0/0');
    expect(reachService(net, 'ws03', '8.8.8.8')).toBe(true);
  });

  it('wrong AS or an ACL on TCP 179 keeps it Active; network statements need a RIB match', () => {
    const { net } = office();
    run(net, 'rtr1', ['en', 'conf t', 'router bgp 65010', 'neighbor 203.0.113.1 remote-as 65000', 'end']);
    expect(run(net, 'rtr1', ['show ip bgp summary'])).toContain('Active');
    run(net, 'rtr1', ['en', 'conf t', 'router bgp 65010', 'neighbor 203.0.113.1 remote-as 64500', 'access-list 101 deny tcp any any eq bgp', 'access-list 101 deny tcp any eq bgp any', 'access-list 101 permit ip any any', 'int g0/1', 'ip access-group 101 in', 'end']);
    expect(run(net, 'rtr1', ['show ip bgp summary'])).toContain('Active');
    run(net, 'rtr1', ['en', 'conf t', 'int g0/1', 'no ip access-group in', 'router bgp 65010', 'network 198.51.100.0 mask 255.255.255.0', 'end']);
    expect(run(net, 'rtr1', ['show ip bgp'])).not.toContain('198.51.100.0');
    expect(run(net, 'rtr1', ['en', 'show run | s router bgp'])).toContain('router bgp 65010\n bgp log-neighbor-changes\n network 198.51.100.0 mask 255.255.255.0\n neighbor 203.0.113.1 remote-as 64500');
  });
});

describe('show ip protocols and errors', () => {
  it('lists each protocol with its networks and passive interfaces', () => {
    const { net } = office();
    const out = run(net, 'core1', ['show ip protocols']);
    expect(out).toContain('Routing Protocol is "ospf 1"');
    expect(out).toContain('    10.10.0.0 0.0.255.255 area 0');
    expect(out).toContain('  Passive Interface(s):\n    Vlan10');
  });

  it('router-id needs clear ip ospf process; prompts and modes', () => {
    const { net } = office();
    const out = run(net, 'core1', ['en', 'conf t', 'router ospf 1', 'router-id 2.2.2.2']);
    expect(out).toContain('CR-CORE1(config-router)#');
    expect(out).toContain('% OSPF: Reload or use "clear ip ospf process" command, for this to take effect');
    const named = run(net, 'core1', ['en', 'conf t', 'router eigrp X', 'address-family ipv4 unicast autonomous-system 5', 'af-interface default', 'exit-af-interface', 'topology base', 'exit-af-topology']);
    expect(named).toContain('CR-CORE1(config-router-af)#');
    expect(named).toContain('CR-CORE1(config-router-af-interface)#');
    expect(named).toContain('CR-CORE1(config-router-af-topology)#');
  });
});

describe('routing tickets, solved the way a player would', () => {
  const start = async (id: string) => {
    const { Game } = await import('../src/game/game');
    const game = new Game(`rt-${id}`);
    game.queue.tickets[0].draft.fix();
    game.queue.startTemplate(id, 0);
    game.tick(5000);
    return { game, t: game.queue.tickets.find((x) => x.draft.templateId === id)! };
  };

  it('passive default: put the uplink exception back', async () => {
    const { game, t } = await start('ospf-passive-default');
    run(game.net, 'core1', ['en', 'conf t', 'router ospf 1', 'no passive-interface fa0/24', 'end']);
    expect(game.queue.resolve(t.id, 'uplink active again').ok).toBe(true);
  });

  it('hello mismatch: compare timers, remove the odd one', async () => {
    const { game, t } = await start('ospf-hello-mismatch');
    expect(run(game.net, 'rtr1', ['en', 'sh ip ospf int g0/0 | i Hello'])).toContain('Hello 5, Dead 20');
    run(game.net, 'rtr1', ['en', 'conf t', 'int g0/0', 'no ip ospf hello-interval', 'end']);
    expect(game.queue.resolve(t.id, 'timers match').ok).toBe(true);
  });

  it('area mismatch: the logs say so; fix the network statement', async () => {
    const { game, t } = await start('ospf-area-mismatch');
    expect(game.net.logs.some((l) => l.message.includes('mismatched area ID') && l.collected !== false)).toBe(true);
    run(game.net, 'rtr1', ['en', 'conf t', 'router ospf 1', 'no network 10.0.0.0 0.0.0.3 area 1', 'network 10.0.0.0 0.0.0.3 area 0', 'end']);
    expect(game.queue.resolve(t.id, 'area 0').ok).toBe(true);
  });

  it('default missing: default-information originate', async () => {
    const { game, t } = await start('ospf-default-missing');
    expect(run(game.net, 'core1', ['show ip route'])).toContain('Gateway of last resort is not set');
    run(game.net, 'rtr1', ['en', 'conf t', 'router ospf 1', 'default-information originate', 'end']);
    expect(game.queue.resolve(t.id, 'default back').ok).toBe(true);
  });

  it('BGP migration: peering alone is not done until the static default is gone', async () => {
    const { game, t } = await start('bgp-migration');
    run(game.net, 'rtr1', ['en', 'conf t', 'router bgp 65010', 'neighbor 203.0.113.1 remote-as 64500', 'end']);
    expect(game.queue.resolve(t.id, 'peered').ok).toBe(false);
    run(game.net, 'rtr1', ['en', 'conf t', 'no ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'end']);
    expect(game.queue.resolve(t.id, 'static removed').ok).toBe(true);
  });
});
