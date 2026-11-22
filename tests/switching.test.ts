import { describe, expect, it } from 'vitest';
import { buildOffice } from '../src/content/office';
import { reachService } from '../src/game/services';
import { run } from './helpers';

const office = () => {
  const o = buildOffice();
  for (const id of ['ws03', 'ws12']) o.net.device(id).powered = true;
  o.net.commit({ silent: true });
  return o;
};
const logs = (net: ReturnType<typeof office>['net'], n = 25) => net.logs.slice(-n).map((l) => `${l.device}: ${l.message}`).join('\n');

describe('spanning tree', () => {
  it('the core is root; bringing up the spare uplink makes STP block one side', () => {
    const { net } = office();
    expect(run(net, 'core1', ['en', 'show spanning-tree vlan 10'])).toContain('This bridge is the root');
    run(net, 'core1', ['en', 'conf t', 'int g0/3', 'no shut', 'end']);
    expect(run(net, 'acc1', ['en', 'show spanning-tree vlan 10'])).toMatch(/Gi0\/1\s+Root FWD 4\s+128\.25\s+P2p/);
    expect(run(net, 'acc1', ['en', 'show spanning-tree vlan 10'])).toMatch(/Gi0\/2\s+Altn BLK 4\s+128\.26\s+P2p/);
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(true);
    // The blocked link takes over if the primary fails.
    run(net, 'core1', ['en', 'conf t', 'int g0/1', 'shut', 'end']);
    expect(run(net, 'acc1', ['en', 'show spanning-tree vlan 10'])).toMatch(/Gi0\/2\s+Root FWD/);
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(true);
  });

  it('BPDU filter on both ends of a redundant link: broadcast storm, everything dies, MACs flap', () => {
    const { net } = office();
    run(net, 'core1', ['en', 'conf t', 'int g0/3', 'spanning-tree bpdufilter enable', 'no shut', 'end']);
    run(net, 'acc1', ['en', 'conf t', 'int g0/2', 'spanning-tree bpdufilter enable', 'end']);
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(false);
    expect(reachService(net, 'ws12', '10.10.20.11')).toBe(false);
    expect(logs(net)).toMatch(/core1: %SW_MATM-4-MACFLAP_NOTIF: Host \S+ in vlan 10 is flapping between port Gi0\/1 and port Gi0\/3/);
    run(net, 'core1', ['en', 'conf t', 'int g0/3', 'shut', 'end']);
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(true);
  });

  it('loop guard holds a port whose switch neighbor goes silent', () => {
    const { net } = office();
    run(net, 'acc1', ['en', 'conf t', 'spanning-tree loopguard default', 'int g0/2', 'spanning-tree bpdufilter disable', 'end']);
    run(net, 'core1', ['en', 'conf t', 'int g0/3', 'spanning-tree bpdufilter enable', 'no shut', 'end']);
    expect(run(net, 'acc1', ['en', 'show spanning-tree vlan 10'])).toContain('BKN*');
    expect(run(net, 'acc1', ['en', 'show spanning-tree inconsistentports'])).toContain('Loop Inconsistent');
    expect(logs(net)).toContain('%SPANTREE-2-LOOPGUARD_BLOCK: Loop guard blocking port GigabitEthernet0/2 on VLAN0010.');
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(true); // no storm
  });

  it('root guard blocks a port that hears a better root', () => {
    const { net } = office();
    run(net, 'core1', ['en', 'conf t', 'int g0/2', 'spanning-tree guard root', 'end']);
    run(net, 'acc2', ['en', 'conf t', 'spanning-tree vlan 10 priority 4096', 'end']);
    expect(run(net, 'core1', ['en', 'show spanning-tree inconsistentports'])).toContain('Root Inconsistent');
    expect(logs(net)).toContain('%SPANTREE-2-ROOTGUARD_BLOCK: Root guard blocking port GigabitEthernet0/2 on VLAN0010.');
    expect(run(net, 'core1', ['en', 'show spanning-tree vlan 10'])).toContain('This bridge is the root');
  });

  it('priority must be a multiple of 4096; root primary sets 24576', () => {
    const { net } = office();
    expect(run(net, 'acc2', ['en', 'conf t', 'spanning-tree vlan 10 priority 5000'])).toContain('% Bridge Priority must be in increments of 4096.');
    run(net, 'acc2', ['en', 'conf t', 'spanning-tree vlan 30 root primary', 'end']);
    expect(run(net, 'acc2', ['en', 'sh run | i priority'])).toContain('spanning-tree vlan 30 priority 24576');
  });

  it('BPDU guard err-disables an access port that hears a switch; shut/no shut recovers once it is gone', () => {
    const { net } = office();
    // Plug the spare uplink port into an access port by mistake: acc1 Gi0/2 becomes access with portfast + guard.
    run(net, 'acc1', ['en', 'conf t', 'int g0/2', 'switchport mode access', 'end']);
    run(net, 'core1', ['en', 'conf t', 'int g0/3', 'no shut', 'end']);
    expect(logs(net)).toContain('%SPANTREE-2-BLOCK_BPDUGUARD: Received BPDU on port GigabitEthernet0/2 with BPDU Guard enabled. Disabling port.');
    expect(logs(net)).toContain('%PM-4-ERR_DISABLE: bpduguard error detected on Gi0/2, putting Gi0/2 in err-disable state');
    expect(run(net, 'acc1', ['en', 'sh int status | i Gi0/2'])).toContain('err-disabled');
    expect(run(net, 'acc1', ['en', 'show int g0/2'])).toContain('GigabitEthernet0/2 is down, line protocol is down (err-disabled)');
    run(net, 'core1', ['en', 'conf t', 'int g0/3', 'shut', 'end']);
    run(net, 'acc1', ['en', 'conf t', 'int g0/2', 'shut', 'no shut', 'end']);
    expect(run(net, 'acc1', ['en', 'sh int status | i Gi0/2'])).not.toContain('err-disabled');
  });
});

describe('port security', () => {
  it('2nd-floor ports learned sticky MACs; a different PC triggers a shutdown violation', () => {
    const { net } = office();
    const cfg = run(net, 'acc2', ['en', 'show run int fa0/2']);
    expect(cfg).toMatch(/ switchport port-security\n switchport port-security mac-address sticky\n switchport port-security mac-address sticky [0-9a-f.]{14}/);
    const pc = net.device('ws12');
    pc.hardware['FastEthernet0'].mac = '00aa.bbcc.0012'; // a loaner PC
    net.commit();
    expect(logs(net)).toContain('%PORT_SECURITY-2-PSECURE_VIOLATION: Security violation occurred, caused by MAC address 00aa.bbcc.0012 on port FastEthernet0/2.');
    expect(logs(net)).toContain('%PM-4-ERR_DISABLE: psecure-violation error detected on Fa0/2, putting Fa0/2 in err-disable state');
    expect(run(net, 'acc2', ['en', 'show port-security interface fa0/2'])).toContain('Port Status                : Secure-shutdown');
    expect(reachService(net, 'ws12', '10.10.20.11')).toBe(false);
    run(net, 'acc2', ['en', 'clear port-security sticky interface fa0/2', 'conf t', 'int fa0/2', 'shut', 'no shut', 'end']);
    expect(reachService(net, 'ws12', '10.10.20.11')).toBe(true);
    expect(run(net, 'acc2', ['en', 'show port-security address'])).toContain('00aa.bbcc.0012    SecureSticky');
  });

  it('restrict keeps the port up but drops the stranger; port security needs a static mode', () => {
    const { net } = office();
    run(net, 'acc2', ['en', 'conf t', 'int fa0/2', 'switchport port-security violation restrict', 'end']);
    net.device('ws12').hardware['FastEthernet0'].mac = '00aa.bbcc.0013';
    net.commit();
    expect(run(net, 'acc2', ['en', 'sh int status | i Fa0/2 '])).toContain('connected');
    expect(reachService(net, 'ws12', '10.10.20.11')).toBe(false);
    expect(run(net, 'acc1', ['en', 'conf t', 'int fa0/15', 'switchport port-security'])).toContain('Command rejected: FastEthernet0/15 is a dynamic port.');
  });

  it('errdisable recovery brings ports back after the interval', () => {
    const { net } = office();
    run(net, 'acc2', ['en', 'conf t', 'errdisable recovery cause psecure-violation', 'errdisable recovery interval 30', 'end']);
    net.device('ws12').hardware['FastEthernet0'].mac = '00aa.bbcc.0014';
    net.commit();
    expect(run(net, 'acc2', ['en', 'show errdisable recovery'])).toMatch(/psecure-violation\s+Enabled/);
    net.device('ws12').hardware['FastEthernet0'].mac = net.device('ws12').hardware['FastEthernet0'].mac; // still the stranger
    net.time += 31_000;
    net.recoverErrDisabled();
    expect(logs(net)).toContain('%PM-4-ERR_RECOVER: Attempting to recover from psecure-violation err-disable state on Fa0/2');
  });
});

describe('EtherChannel', () => {
  it('LACP active/passive bundles both uplinks into Po1; STP sees one link', () => {
    const { net } = office();
    run(net, 'core1', ['en', 'conf t', 'int range g0/1, g0/3', 'channel-group 1 mode active', 'no shut', 'end']);
    const out = run(net, 'acc1', ['en', 'conf t', 'int range g0/1 - 2', 'channel-group 1 mode passive', 'end', 'show etherchannel summary']);
    expect(out).toContain('Creating a port-channel interface Port-channel1');
    expect(out).toMatch(/1\s+Po1\(SU\)\s+LACP\s+Gi0\/1\(P\)\s+Gi0\/2\(P\)/);
    expect(run(net, 'acc1', ['en', 'show spanning-tree vlan 10'])).toMatch(/Po1\s+Root FWD 3\s+128\.65/);
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(true);
    // Losing one member keeps the channel up.
    run(net, 'core1', ['en', 'conf t', 'int g0/1', 'shut', 'end']);
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(true);
  });

  it('mode mismatches: passive/passive and on/active never bundle; on vs PAgP suspends', () => {
    const { net } = office();
    run(net, 'core1', ['en', 'conf t', 'int range g0/1, g0/3', 'channel-group 1 mode passive', 'no shut', 'end']);
    run(net, 'acc1', ['en', 'conf t', 'int range g0/1 - 2', 'channel-group 1 mode passive', 'end']);
    expect(run(net, 'acc1', ['en', 'show etherchannel summary'])).toContain('Gi0/1(I)');
    run(net, 'acc1', ['en', 'conf t', 'int range g0/1 - 2', 'no channel-group', 'channel-group 2 mode on', 'end']);
    expect(run(net, 'acc1', ['en', 'show etherchannel summary'])).toContain('Gi0/1(s)');
  });

  it('settings on the port-channel apply to the members; a member that differs is suspended', () => {
    const { net } = office();
    run(net, 'core1', ['en', 'conf t', 'int range g0/1, g0/3', 'channel-group 1 mode active', 'no shut', 'end']);
    run(net, 'acc1', ['en', 'conf t', 'int range g0/1 - 2', 'channel-group 1 mode active', 'end']);
    run(net, 'acc1', ['en', 'conf t', 'int po1', 'switchport trunk allowed vlan 10,20,30,40,99', 'end']);
    expect(run(net, 'acc1', ['en', 'sh run int g0/2'])).toContain('switchport trunk allowed vlan 10,20,30,40,99');
    run(net, 'acc1', ['en', 'conf t', 'int g0/2', 'switchport trunk allowed vlan 10', 'end']);
    expect(run(net, 'acc1', ['en', 'show etherchannel summary'])).toContain('Gi0/2(s)');
    expect(logs(net)).toContain('%EC-5-CANNOT_BUNDLE2: GigabitEthernet0/2 is not compatible with Port-channel1 and will be suspended');
  });
});

describe('VTP', () => {
  it('transparent everywhere by default; VLANs show in the running config', () => {
    const { net } = office();
    const out = run(net, 'acc1', ['en', 'show vtp status', 'sh run | s ^vlan']);
    expect(out).toContain('VTP Operating Mode                : Transparent');
    expect(out).toContain('VTP Domain Name                 : CEDAR');
    expect(out).toContain('vlan 10\n name STAFF');
  });

  it('server/client: a client refuses VLAN changes and follows the server', () => {
    const { net } = office();
    run(net, 'core1', ['en', 'conf t', 'vtp mode server', 'vlan 60', 'name VOICE', 'end']);
    run(net, 'acc1', ['en', 'conf t', 'vtp mode client', 'end']);
    expect(run(net, 'acc1', ['en', 'conf t', 'vlan 70'])).toContain('VTP VLAN configuration not allowed when device is in CLIENT mode.');
    run(net, 'core1', ['en', 'conf t', 'vlan 61', 'end']);
    expect(run(net, 'acc1', ['en', 'show vlan brief'])).toContain('61   VLAN0061');
  });

  it('the revision wipe: a higher-revision server with fewer VLANs erases them everywhere', () => {
    const { net } = office();
    run(net, 'core1', ['en', 'conf t', 'vtp mode server', 'end']);
    run(net, 'acc1', ['en', 'conf t', 'vtp mode client', 'end']);
    const acc2 = net.device('acc2');
    run(net, 'acc2', ['en', 'conf t', 'vtp mode server', 'no vlan 30', 'no vlan 40', 'end']);
    acc2.vtpRevision = 50;
    net.commit();
    expect(run(net, 'core1', ['en', 'show vlan brief'])).not.toContain('PRINTERS');
    expect(reachService(net, 'ws03', '10.10.30.21')).toBe(false);
    expect(run(net, 'core1', ['en', 'show vtp status'])).toContain('Configuration Revision            : 50');
  });
});

describe('switching tickets, solved the way a player would', () => {
  const start = async (id: string) => {
    const { Game } = await import('../src/game/game');
    const game = new Game(`sw-${id}`);
    game.queue.tickets[0].draft.fix();
    game.queue.startTemplate(id, 0);
    game.tick(5000);
    return { game, t: game.queue.tickets.find((x) => x.draft.templateId === id)! };
  };

  it('storm: MAC flaps point at the loop; shutting the spare uplink ends it', async () => {
    const { game, t } = await start('stp-loop');
    expect(game.net.logs.some((l) => l.message.includes('MACFLAP_NOTIF') && l.message.includes('Gi0/3'))).toBe(true);
    run(game.net, 'core1', ['en', 'conf t', 'int g0/3', 'shutdown', 'end']);
    expect(game.queue.resolve(t.id, 'loop broken').ok).toBe(true);
  });

  it('desk switch: err-disabled by BPDU guard; shut/no shut', async () => {
    const { game, t } = await start('bpduguard-desk-switch');
    const port = game.net.peerOf(t.draft.reporter.pcId, 'FastEthernet0')!;
    expect(run(game.net, port.device, ['en', 'show interfaces status err-disabled'])).toContain('err-disabled');
    run(game.net, port.device, ['en', 'conf t', `int ${port.iface}`, 'shut', 'no shut', 'end']);
    expect(game.queue.resolve(t.id, 'bounced').ok).toBe(true);
  });

  it('loaner: clear the sticky MAC and bounce the port', async () => {
    const { game, t } = await start('psecure-loaner');
    const port = game.net.peerOf(t.draft.reporter.pcId, 'FastEthernet0')!;
    run(game.net, 'acc2', ['en', `clear port-security sticky interface ${port.iface}`, 'conf t', `int ${port.iface}`, 'shut', 'no shut', 'end']);
    expect(game.queue.resolve(t.id, 'cleared').ok).toBe(true);
  });

  it('EtherChannel request: LACP on both switches', async () => {
    const { game, t } = await start('etherchannel-uplinks');
    run(game.net, 'core1', ['en', 'conf t', 'int range g0/1, g0/3', 'channel-group 1 mode active', 'no shut', 'end']);
    run(game.net, 'acc1', ['en', 'conf t', 'int range g0/1 - 2', 'channel-group 1 mode active', 'end']);
    expect(game.queue.resolve(t.id, 'bundled').ok).toBe(true);
  });

  it('VTP wipe: back to transparent and recreate the VLANs', async () => {
    const { game, t } = await start('vtp-wipe');
    expect(run(game.net, 'acc1', ['en', 'show vlan brief'])).not.toContain('PRINTERS');
    for (const sw of ['core1', 'acc1', 'acc2']) {
      run(game.net, sw, ['en', 'conf t', 'vtp mode transparent', 'vlan 30', 'name PRINTERS', 'vlan 40', 'name GUEST', 'end']);
    }
    game.tick(5000);
    expect(game.queue.resolve(t.id, 'vlans back').ok).toBe(true);
  });
});
