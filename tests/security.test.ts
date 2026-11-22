import { describe, expect, it } from 'vitest';
import { buildOffice } from '../src/content/office';
import { reachService } from '../src/game/services';
import { CliSession } from '../src/sim/cli/session';
import { createDevice } from '../src/sim/devices';
import { dhcpRequest, dhcpWouldWork } from '../src/sim/dhcp';
import { parseIp } from '../src/sim/ip';
import { canReach } from '../src/sim/routing';
import { run } from './helpers';
import { TEMPLATES } from '../src/game/templates';
import { Rng } from '../src/sim/rng';

const office = () => {
  const o = buildOffice();
  for (const id of ['ws03', 'ws12']) o.net.device(id).powered = true;
  o.net.commit({ silent: true });
  return o;
};
const logs = (net: ReturnType<typeof office>['net'], n = 30) => net.logs.slice(-n).map((l) => `${l.device}: ${l.message}`).join('\n');

describe('DHCP snooping', () => {
  it('an untrusted uplink drops the server replies; trusting it meets option 82 at the relay', () => {
    const { net } = office();
    run(net, 'acc1', ['en', 'conf t', 'ip dhcp snooping', 'ip dhcp snooping vlan 10', 'end']);
    expect(dhcpWouldWork(net, 'ws03')).toBe(false);
    run(net, 'acc1', ['en', 'conf t', 'int g0/1', 'ip dhcp snooping trust', 'end']);
    // Option 82 with giaddr 0: the core (the relay) drops it unless it trusts relay information.
    expect(dhcpWouldWork(net, 'ws03')).toBe(false);
    run(net, 'core1', ['en', 'conf t', 'int vlan 10', 'ip dhcp relay information trusted', 'end']);
    expect(dhcpWouldWork(net, 'ws03')).toBe(true);
    run(net, 'core1', ['en', 'conf t', 'int vlan 10', 'no ip dhcp relay information trusted', 'end']);
    run(net, 'acc1', ['en', 'conf t', 'no ip dhcp snooping information option', 'end']);
    expect(dhcpWouldWork(net, 'ws03')).toBe(true);
    // The lease creates a binding on the access switch.
    expect(dhcpRequest(net, 'ws03').ok).toBe(true);
    const port = net.peerOf('ws03', 'FastEthernet0')!.iface;
    const b = run(net, 'acc1', ['show ip dhcp snooping binding']);
    expect(b).toMatch(new RegExp(`dhcp-snooping\\s+10\\s+${port}`));
    expect(b).toContain('Total number of bindings: 1');
    const cfg = run(net, 'acc1', ['en', 'show run']);
    expect(cfg).toContain('ip dhcp snooping vlan 10\nno ip dhcp snooping information option\nip dhcp snooping');
    expect(cfg).toContain(' ip dhcp snooping trust');
    expect(run(net, 'acc1', ['show ip dhcp snooping'])).toContain('Insertion of option 82 is disabled');
  });

  it('a rogue DHCP server answers first; snooping on an untrusted port silences it', () => {
    const { net } = office();
    // A home router on an empty desk port, handing out 192.168.1.x.
    const r = net.addDevice(createDevice('rogue', 'NS-PC', 'HOME-ROUTER'));
    const nic = Object.keys(r.hardware)[0];
    r.running.interfaces[nic].ip = { address: parseIp('192.168.1.1')!, prefix: 24 };
    r.dhcpServer = { scopes: [{ network: parseIp('192.168.1.0')!, prefix: 24, start: parseIp('192.168.1.100')!, end: parseIp('192.168.1.199')!, gateway: parseIp('192.168.1.1')!, dns: parseIp('192.168.1.1')!, reservations: {}, leases: {} }] };
    const port = net.device('acc1').running.interfaces['FastEthernet0/15'];
    port.switchport!.accessVlan = 10;
    net.connect('rogue', nic, 'acc1', 'FastEthernet0/15');
    net.commit();
    const lease = dhcpRequest(net, 'ws03');
    expect(lease.ok && lease.lease.gateway).toBe(parseIp('192.168.1.1'));
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(false);
    run(net, 'acc1', ['en', 'conf t', 'ip dhcp snooping', 'ip dhcp snooping vlan 10', 'no ip dhcp snooping information option', 'int g0/1', 'ip dhcp snooping trust', 'end']);
    const again = dhcpRequest(net, 'ws03');
    expect(again.ok && again.lease.gateway).toBe(parseIp('10.10.10.1'));
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(true);
  });
});

describe('dynamic ARP inspection', () => {
  const snooped = () => {
    const o = office();
    run(o.net, 'acc1', ['en', 'conf t', 'ip dhcp snooping', 'ip dhcp snooping vlan 10,30', 'no ip dhcp snooping information option', 'int g0/1', 'ip dhcp snooping trust', 'end']);
    return o;
  };

  it('an untrusted uplink blows its ARP rate limit and err-disables, taking the floor down', () => {
    const { net } = snooped();
    run(net, 'acc1', ['en', 'conf t', 'ip arp inspection vlan 10', 'end']);
    expect(net.device('acc1').errDisabled?.['GigabitEthernet0/1']?.cause).toBe('arp-inspection');
    expect(logs(net)).toMatch(/acc1: %SW_DAI-4-PACKET_RATE_EXCEEDED: \d+ packets received in 1000 milliseconds on Gi0\/1\./);
    expect(logs(net)).toMatch(/%PM-4-ERR_DISABLE: arp-inspection error detected on Gi0\/1/);
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(false);
  });

  it('hosts without a binding are cut off until they renew; trusted uplink, bindings and ARP ACLs let traffic through', () => {
    const { net } = snooped();
    run(net, 'acc1', ['en', 'conf t', 'int g0/1', 'ip arp inspection trust', 'exit', 'ip arp inspection vlan 10,30', 'end']);
    expect(net.device('acc1').errDisabled?.['GigabitEthernet0/1']).toBeUndefined();
    // ws03's lease predates snooping: no binding, so its ARPs are dropped.
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(false);
    expect(logs(net)).toMatch(/acc1: %SW_DAI-4-DHCP_SNOOPING_DENY: 1 Invalid ARPs \(Req\) on Fa0\/\d+, vlan 10\./);
    dhcpRequest(net, 'ws03');
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(true);
    // The printer has a static address: no DHCP, no binding.
    expect(reachService(net, 'ws03', '10.10.30.21')).toBe(false);
    const mac = net.device('prn1').hardware[Object.keys(net.device('prn1').hardware)[0]].mac;
    run(net, 'acc1', ['en', 'conf t', 'arp access-list PRINTERS', `permit ip host 10.10.30.21 mac host ${mac}`, 'exit', 'ip arp inspection filter PRINTERS vlan 30', 'end']);
    expect(reachService(net, 'ws03', '10.10.30.21')).toBe(true);
    expect(run(net, 'acc1', ['show ip arp inspection vlan 30'])).toMatch(/30\s+Enabled\s+Active\s+PRINTERS\s+No/);
  });
});

describe('IP source guard', () => {
  it('only the address in the binding gets out of the port', () => {
    const { net } = office();
    run(net, 'acc1', ['en', 'conf t', 'ip dhcp snooping', 'ip dhcp snooping vlan 10', 'no ip dhcp snooping information option', 'int g0/1', 'ip dhcp snooping trust', 'end']);
    const port = net.peerOf('ws03', 'FastEthernet0')!.iface;
    run(net, 'acc1', ['en', 'conf t', `int ${port}`, 'ip verify source', 'end']);
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(false);
    dhcpRequest(net, 'ws03');
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(true);
    expect(run(net, 'acc1', ['show ip verify source'])).toMatch(/ip\s+active\s+10\.10\.10\.\d+/);
  });
});

describe('more ACL types', () => {
  it('time-based: the guest internet ACL follows the router clock', () => {
    const { net } = office();
    // The office clock starts Tue Apr 14 2026 08:00 UTC.
    run(net, 'rtr1', ['en', 'conf t', 'time-range LUNCH', 'periodic weekdays 12:00 to 13:00', 'exit', 'ip access-list extended NO-LUNCH-WEB', 'deny tcp any any eq 443 time-range LUNCH', 'permit ip any any', 'int g0/0', 'ip access-group NO-LUNCH-WEB in', 'end']);
    expect(reachService(net, 'ws03', '8.8.8.8')).toBe(true);
    expect(run(net, 'rtr1', ['show time-range'])).toContain('time-range entry: LUNCH (inactive)');
    net.advance(4.5 * 3600000);
    expect(reachService(net, 'ws03', '8.8.8.8')).toBe(false);
    const acl = run(net, 'rtr1', ['show access-lists NO-LUNCH-WEB']);
    expect(acl).toContain('10 deny tcp any any eq 443 time-range LUNCH (active)');
    expect(run(net, 'rtr1', ['en', 'show run | section time-range'])).toContain('time-range LUNCH\n periodic weekdays 12:00 to 13:00');
  });

  it('reflexive: replies to traffic that went out come back in, nothing else does', () => {
    const { net } = office();
    run(net, 'rtr1', ['en', 'conf t', 'ip access-list extended OUTBOUND', 'permit tcp any any reflect MIRROR', 'permit icmp any any reflect MIRROR', 'permit udp any any reflect MIRROR', 'ip access-list extended INBOUND', 'evaluate MIRROR', 'int g0/1', 'ip access-group OUTBOUND out', 'ip access-group INBOUND in', 'end']);
    expect(reachService(net, 'ws03', '8.8.8.8')).toBe(true);
    // From the internet side, nothing new gets in.
    expect(canReach(net, 'internet', parseIp('203.0.113.2')!, { proto: 'tcp', port: 22 })).toBe(false);
    expect(run(net, 'rtr1', ['show access-lists'])).toContain('Reflexive IP access list MIRROR');
    expect(run(net, 'rtr1', ['en', 'show run | section INBOUND'])).toContain(' evaluate MIRROR');
  });

  it('port ACL on an access port filters what the host sends', () => {
    const { net } = office();
    const port = net.peerOf('ws03', 'FastEthernet0')!.iface;
    run(net, 'acc1', ['en', 'conf t', 'ip access-list extended NO-FS', 'deny ip any host 10.10.20.11', 'permit ip any any', `int ${port}`, 'ip access-group NO-FS in', 'end']);
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(false);
    expect(reachService(net, 'ws03', '8.8.8.8')).toBe(true);
    expect(run(net, 'acc1', ['en', 'conf t', `int ${port}`, 'ip access-group NO-FS out'])).toContain('% Out ACLs are not supported on Layer 2 interfaces');
  });

  it('VLAN access map: matched traffic dropped, and forgetting the final forward entry drops everything', () => {
    const { net } = office();
    run(net, 'core1', ['en', 'conf t', 'ip access-list extended TO-FS', 'permit ip any host 10.10.20.11', 'vlan access-map SRV 10', 'match ip address TO-FS', 'action drop', 'exit', 'vlan filter SRV vlan-list 20', 'end']);
    // Only entry 10 exists: everything else hits the implicit drop.
    expect(reachService(net, 'ws03', '10.10.20.10')).toBe(false);
    run(net, 'core1', ['en', 'conf t', 'vlan access-map SRV 20', 'action forward', 'end']);
    expect(reachService(net, 'ws03', '10.10.20.10')).toBe(true);
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(false);
    expect(run(net, 'core1', ['show vlan access-map SRV'])).toContain('Vlan access-map "SRV"  10');
    expect(run(net, 'core1', ['show vlan filter'])).toContain('VLAN Map SRV is filtering VLANs:\n  20');
  });

  it('MAC ACLs configure and show, resequence renumbers', () => {
    const { net } = office();
    const out = run(net, 'acc1', ['en', 'conf t', 'mac access-list extended NO-APPLETALK', 'deny any any', 'exit', 'int fa0/5', 'mac access-group NO-APPLETALK in', 'end', 'show access-lists']);
    expect(out).toContain('Extended MAC access list NO-APPLETALK\n    deny any any');
    // MAC ACLs only filter non-IP frames: IP traffic still flows.
    run(net, 'core1', ['en', 'conf t', 'ip access-list extended X', '5 permit ip any any', '7 deny ip any any', 'exit', 'ip access-list resequence X 100 20', 'end']);
    expect(run(net, 'core1', ['show access-lists X'])).toMatch(/100 permit ip any any\n\s+120 deny ip any any/);
  });
});

describe('NSOS upgrades', () => {
  const NEW = 'nss2900-lanbasek9-mz.152-7.E9.bin';
  const OLD = 'nss2900-lanbasek9-mz.150-2.SE4.bin';

  it('flash too small for two images: delete the old one, copy, verify, boot system, reload', () => {
    const { net } = office();
    expect(run(net, 'acc2', ['show version'])).toContain('Version 15.0(2)SE4');
    const first = run(net, 'acc2', ['en', `copy tftp://10.10.99.50/${NEW} flash:`, '', '', '']);
    expect(first).toContain('Not enough space on device');
    run(net, 'acc2', ['en', `delete flash:${OLD}`, '', '']);
    const ok = run(net, 'acc2', ['en', `copy tftp://10.10.99.50/${NEW} flash:`, '', '', '']);
    expect(ok).toContain(`[OK - 19906560 bytes]`);
    const md5 = /= ([0-9a-f]{32})/.exec(run(net, 'acc2', ['en', `verify /md5 flash:${NEW}`]))![1];
    expect(run(net, 'acc2', ['en', `verify /md5 flash:${NEW} ${md5}`])).toContain('Verified');
    expect(run(net, 'acc2', ['en', `verify /md5 flash:${NEW} 0123`])).toContain('%Error verifying');
    // Still running the old image from RAM until the reload.
    expect(run(net, 'acc2', ['show version'])).toContain('Version 15.0(2)SE4');
    run(net, 'acc2', ['en', 'conf t', `boot system flash:${NEW}`, 'end', 'write memory', 'reload', '']);
    net.advance(46000);
    const v = run(net, 'acc2', ['', 'show version']);
    expect(v).toContain('Version 15.2(7)E9');
    expect(v).toContain(`System image file is "flash:${NEW}"`);
  });

  it('no bootable image: ROMMON, and xmodem then boot brings it back', () => {
    const { net } = office();
    run(net, 'acc1', ['en', `delete /force flash:${OLD}`, 'reload', '']);
    net.advance(46000);
    const s = new CliSession(net, 'acc1');
    s.checkBoot();
    expect(s.promptText()).toBe('switch: ');
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(false);
    expect(run(net, 'acc1', ['dir flash:'], s)).toContain('bytes available');
    expect(run(net, 'acc1', [`copy xmodem: flash:${NEW}`], s)).toContain('successfully copied');
    run(net, 'acc1', [`boot flash:${NEW}`], s);
    net.advance(46000);
    expect(reachService(net, 'ws03', '10.10.20.11')).toBe(true);
  });

  it('reload in schedules a reload; reload cancel stops it', () => {
    const { net } = office();
    run(net, 'core1', ['en', 'reload in 30', '']);
    expect(run(net, 'core1', ['en', 'show reload'])).toContain('(in 0 hours 30 minutes)');
    run(net, 'core1', ['en', 'reload cancel']);
    expect(run(net, 'core1', ['en', 'show reload'])).toContain('No reload is scheduled.');
  });
});

describe('security tickets, solved the way a player would', () => {
  const start = (id: string) => {
    const o = buildOffice('sec');
    const t = TEMPLATES.find((x) => x.id === id)!;
    const ctx = { net: o.net, office: o, rng: new Rng(id), busyPcs: new Set([o.tutorial.pcId]), activeTemplates: new Set<string>(), usedTemplates: new Set<string>() };
    const draft = t.build(ctx, JSON.parse(JSON.stringify(t.plan(ctx))));
    draft.inject();
    return { o, draft };
  };

  it('snooping rollout: trusting the uplink is not enough until option 82 is handled', () => {
    const { o, draft } = start('snooping-rollout');
    for (const sw of ['acc1', 'acc2']) {
      const up = o.net.device(sw).hardware['GigabitEthernet0/1'] && o.net.peerOf(sw, 'GigabitEthernet0/1')?.device === 'core1' ? 'g0/1' : 'g0/2';
      run(o.net, sw, ['en', 'conf t', 'ip dhcp snooping', 'ip dhcp snooping vlan 10', `int ${up}`, 'ip dhcp snooping trust', 'end']);
    }
    expect(draft.check()).toBe(false);
    run(o.net, 'core1', ['en', 'conf t', 'ip dhcp relay information trust-all', 'end']);
    expect(draft.check()).toBe(true);
  });

  it('option 82 outage: fix the switch, then the PCs renew', () => {
    const { o, draft } = start('option82-outage');
    run(o.net, 'acc2', ['en', 'conf t', 'no ip dhcp snooping information option', 'end']);
    expect(draft.check()).toBe(false);
    for (const pc of draft.pcs) dhcpRequest(o.net, pc);
    expect(draft.check()).toBe(true);
  });

  it('printers vs DAI: an ARP ACL for the printer', () => {
    const { o, draft } = start('dai-printers');
    const sw = String(draft.params.sw);
    const prn = o.net.device(sw === 'acc1' ? 'prn1' : 'prn2');
    const mac = prn.hardware[Object.keys(prn.hardware)[0]].mac;
    const ip = sw === 'acc1' ? '10.10.30.21' : '10.10.30.22';
    expect(o.net.logs.some((l) => l.message.includes('%SW_DAI-4-DHCP_SNOOPING_DENY')) || !draft.check()).toBe(true);
    run(o.net, sw, ['en', 'conf t', 'arp access-list PRN', `permit ip host ${ip} mac host ${mac}`, 'exit', 'ip arp inspection filter PRN vlan 30', 'end']);
    expect(draft.check()).toBe(true);
  });

  it('shut unused ports with interface range, everyone still works', () => {
    const { o, draft } = start('shut-unused-ports');
    for (const sw of ['acc1', 'acc2']) {
      const d = o.net.device(sw);
      const empty = Object.keys(d.hardware).filter((p) => p.startsWith('FastEthernet') && !o.net.linkAt(sw, p)).map((p) => p.replace('FastEthernet', 'fa'));
      run(o.net, sw, ['en', 'conf t', ...empty.map((p) => `int ${p}`).flatMap((x) => [x, 'shutdown']), 'end']);
    }
    expect(draft.check()).toBe(true);
  });

  it('guest hours: time-range on the guest ACL', () => {
    const { o, draft } = start('guest-hours');
    run(o.net, 'core1', ['en', 'conf t', 'time-range OFFICE', 'periodic weekdays 7:00 to 19:00', 'exit', 'ip access-list extended GUEST-IN', 'no 40', '40 permit ip 10.10.40.0 0.0.0.255 any time-range OFFICE', 'end']);
    expect(draft.check()).toBe(true);
  });
});
