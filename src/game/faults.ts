// Fault building blocks for the generator. Each one is a real thing that goes wrong on a network like Cedar Ridge's,
// can land on many places ("sites"), knows who it would hurt, how to break it, how a senior would fix it, and how
// to explain it. Sites are plain JSON so a generated ticket survives a save; inject() records the original values
// in the site so fix() can put them back.

import type { Office } from '../content/office';
import { dhcpRequest, forceApipa } from '../sim/dhcp';
import { parseIp } from '../sim/ip';
import type { Network } from '../sim/network';
import { CURRENT_NIC_DRIVER } from '../sim/types';
import type { Difficulty } from './scoring';
import { NIC } from './ticketKit';

export type Site = Record<string, string | number | boolean | null>;

export interface Fault {
  id: string;
  difficulty: Difficulty;
  /** How often it happens. The everyday regulars are heavy; the strange ones are rare. */
  weight: number;
  /** Fixed at the desk (or by talking the user through it), not from a console. */
  desk?: boolean;
  /** Worn-out or failed hardware: only the breakage clock (breakage.ts) causes these, not the ticket generator. */
  hardware?: boolean;
  /** Hardware only: the broken part has been replaced or worked around (for repair times). */
  repaired?(net: Network, site: Site): boolean;
  /** Places it can happen right now. `people` are PCs free to be involved. */
  sites(net: Network, office: Office, people: string[]): Site[];
  /** PCs it would hurt (a sample is enough for office-wide faults). */
  victims(net: Network, office: Office, site: Site): string[];
  /** Device whose configuration changes (for "Configured from console by ..." logs). */
  configOn?(site: Site): string;
  /** Things two faults mustn't both touch. */
  resources(site: Site): string[];
  inject(net: Network, site: Site): void;
  fix(net: Network, site: Site): void;
  explain(net: Network, site: Site): string;
  hint: string;
}

const s = (x: unknown) => String(x);
const short = (iface: string) => iface.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gi');
const swName = (sw: unknown) => ({ acc1: 'CR-ACC1', acc2: 'CR-ACC2', core1: 'CR-CORE1', rtr1: 'CR-RTR1' })[s(sw)] ?? s(sw);
const floorOf = (net: Network, pc: string) => net.peerOf(pc, NIC)?.device ?? '';
const floorPeople = (net: Network, office: Office, sw: string) => office.people.filter((p) => floorOf(net, p.pcId) === sw).map((p) => p.pcId);
const staff = (office: Office) => office.people.map((p) => p.pcId);
const sample = (list: string[], n: number) => list.slice(0, n);

/** A free person's PC on an access switch, with the port. */
function pcSites(net: Network, people: string[], ok: (pc: string, sw: string, port: string) => boolean = () => true): Site[] {
  return people
    .map((pc) => ({ pc, peer: net.peerOf(pc, NIC) }))
    .filter((x) => x.peer && (x.peer.device === 'acc1' || x.peer.device === 'acc2') && ok(x.pc, x.peer.device, x.peer.iface))
    .map((x) => ({ pc: x.pc, sw: x.peer!.device, port: x.peer!.iface }));
}

function renew(net: Network, pcs: string[]): void {
  for (const pc of pcs) {
    const d = net.device(pc);
    if (d.hostNet?.dhcp) dhcpRequest(net, pc);
  }
}

const uplink = (net: Network, sw: string) => Object.keys(net.device(sw).hardware).find((p) => net.peerOf(sw, p)?.device === 'core1' && net.isUp(sw, p));

// ---------------------------------------------------------------- at one desk

const portShut: Fault = {
  id: 'port-shut',
  difficulty: 'trivial',
  weight: 10,
  sites: (net, _o, people) => pcSites(net, people, (_pc, sw, port) => !net.device(sw).running.interfaces[port].shutdown),
  victims: (_n, _o, site) => [s(site.pc)],
  configOn: (site) => s(site.sw),
  resources: (site) => [`port:${site.sw}:${site.port}`, `pc:${site.pc}`],
  inject: (net, site) => {
    net.device(s(site.sw)).running.interfaces[s(site.port)].shutdown = true;
    net.commit();
  },
  fix: (net, site) => {
    net.device(s(site.sw)).running.interfaces[s(site.port)].shutdown = false;
    net.commit();
    renew(net, [s(site.pc)]);
  },
  explain: (_n, site) => `${swName(site.sw)} ${short(s(site.port))} had been shut down. \`no shutdown\` brought the PC's link back.`,
  hint: 'Start with the switch port the PC plugs into.',
};

const wrongVlan: Fault = {
  id: 'access-vlan',
  difficulty: 'easy',
  weight: 8,
  sites: (net, _o, people) => pcSites(net, people, (_pc, sw, port) => net.device(sw).running.interfaces[port].switchport?.accessVlan === 10).map((x, i) => ({ ...x, bad: i % 2 ? 20 : 30 })),
  victims: (_n, _o, site) => [s(site.pc)],
  configOn: (site) => s(site.sw),
  resources: (site) => [`port:${site.sw}:${site.port}`, `pc:${site.pc}`],
  inject: (net, site) => {
    net.device(s(site.sw)).running.interfaces[s(site.port)].switchport!.accessVlan = Number(site.bad);
    net.commit();
    renew(net, [s(site.pc)]);
  },
  fix: (net, site) => {
    net.device(s(site.sw)).running.interfaces[s(site.port)].switchport!.accessVlan = 10;
    net.commit();
    renew(net, [s(site.pc)]);
  },
  explain: (_n, site) => `${swName(site.sw)} ${short(s(site.port))} was in VLAN ${site.bad} instead of the staff VLAN 10, so the PC was on the wrong network (and DHCP failed). Back to \`switchport access vlan 10\`, then a renew.`,
  hint: 'The link is up, so look at which VLAN the port is in.',
};

const accessTrunk: Fault = {
  id: 'access-port-trunk',
  difficulty: 'moderate',
  weight: 2,
  sites: (net, _o, people) => pcSites(net, people, (_pc, sw, port) => net.device(sw).running.interfaces[port].switchport?.mode === 'access'),
  victims: (_n, _o, site) => [s(site.pc)],
  configOn: (site) => s(site.sw),
  resources: (site) => [`port:${site.sw}:${site.port}`, `pc:${site.pc}`],
  inject: (net, site) => {
    net.device(s(site.sw)).running.interfaces[s(site.port)].switchport!.mode = 'trunk';
    net.commit();
    renew(net, [s(site.pc)]);
  },
  fix: (net, site) => {
    net.device(s(site.sw)).running.interfaces[s(site.port)].switchport!.mode = 'access';
    net.commit();
    renew(net, [s(site.pc)]);
  },
  explain: (_n, site) => `${swName(site.sw)} ${short(s(site.port))} had been changed to \`switchport mode trunk\`. The PC's untagged frames landed in the native VLAN 1, where there's no DHCP. Setting it back to \`switchport mode access\` fixed it.`,
  hint: 'The port is up but the PC has no proper address. What mode is that switchport in?',
};

const cableOut: Fault = {
  id: 'cable-out',
  difficulty: 'trivial',
  weight: 7,
  desk: true,
  sites: (net, _o, people) => pcSites(net, people, (pc) => net.linkAt(pc, NIC)?.cable === 'ok'),
  victims: (_n, _o, site) => [s(site.pc)],
  resources: (site) => [`pc:${site.pc}`, `cable:${site.pc}`],
  inject: (net, site) => {
    net.linkAt(s(site.pc), NIC)!.cable = 'unplugged';
    net.commit();
  },
  fix: (net, site) => {
    const l = net.linkAt(s(site.pc), NIC);
    if (l) l.cable = 'ok';
    net.commit();
    renew(net, [s(site.pc)]);
  },
  explain: () => 'The patch cable had come out of the back of the PC. Plugged it back in.',
  hint: 'Is the link light on at the PC? Is the port even up on the switch?',
};

const cableBad: Fault = {
  id: 'cable-bad',
  difficulty: 'easy',
  weight: 4,
  desk: true,
  hardware: true,
  sites: (net, _o, people) => pcSites(net, people, (pc) => net.linkAt(pc, NIC)?.cable === 'ok'),
  victims: (_n, _o, site) => [s(site.pc)],
  resources: (site) => [`pc:${site.pc}`, `cable:${site.pc}`],
  inject: (net, site) => {
    net.linkAt(s(site.pc), NIC)!.cable = 'cut';
    net.commit();
  },
  fix: (net, site) => {
    const l = net.linkAt(s(site.pc), NIC);
    if (l) l.cable = 'ok';
    net.commit();
    renew(net, [s(site.pc)]);
  },
  repaired: (net, site) => net.linkAt(s(site.pc), NIC)?.cable !== 'cut',
  explain: () => 'The patch cable was crushed under a chair wheel. Reseating didn\'t help; replacing the cable did.',
  hint: 'Plugged in at both ends, port configured fine, but no link. Look at the cable itself.',
};

const nicOff: Fault = {
  id: 'nic-disabled',
  difficulty: 'trivial',
  weight: 4,
  desk: true,
  sites: (net, _o, people) => pcSites(net, people, (pc) => !!net.device(pc).nic && !net.device(pc).nic!.disabled),
  victims: (_n, _o, site) => [s(site.pc)],
  resources: (site) => [`pc:${site.pc}`, `nic:${site.pc}`],
  inject: (net, site) => {
    net.device(s(site.pc)).nic!.disabled = true;
    net.commit();
  },
  fix: (net, site) => {
    net.device(s(site.pc)).nic!.disabled = false;
    net.commit();
    renew(net, [s(site.pc)]);
  },
  explain: () => 'The network adapter had been disabled in Windows. Enabled it again.',
  hint: 'The switch says the port is down, but the cable is fine. What does the PC think of its adapter?',
};

const driverOld: Fault = {
  id: 'nic-driver',
  difficulty: 'easy',
  weight: 3,
  desk: true,
  sites: (net, _o, people) => pcSites(net, people, (pc) => net.device(pc).nic?.driver === 'ok'),
  victims: (_n, _o, site) => [s(site.pc)],
  resources: (site) => [`pc:${site.pc}`, `nic:${site.pc}`],
  inject: (net, site) => {
    Object.assign(net.device(s(site.pc)).nic!, { driver: 'outdated', version: '2.0.9' });
    net.commit();
  },
  fix: (net, site) => {
    Object.assign(net.device(s(site.pc)).nic!, { driver: 'ok', version: CURRENT_NIC_DRIVER });
    net.commit();
    renew(net, [s(site.pc)]);
  },
  explain: () => 'An update rolled the network driver back to an old version that won\'t start (Code 10 in Device Manager). Installing the current driver fixed it.',
  hint: 'No link from the PC side, cable and port fine. Check Device Manager.',
};

const staticGateway: Fault = {
  id: 'static-gateway',
  difficulty: 'easy',
  weight: 3,
  desk: true,
  sites: (net, _o, people) => pcSites(net, people, (pc) => !!net.device(pc).hostNet?.dhcp && !net.device(pc).hostNet!.apipa && !!net.device(pc).running.interfaces[NIC].ip),
  victims: (_n, _o, site) => [s(site.pc)],
  resources: (site) => [`pc:${site.pc}`, `ip:${site.pc}`],
  inject: (net, site) => {
    const d = net.device(s(site.pc));
    const addr = d.running.interfaces[NIC].ip;
    Object.assign(d.hostNet!, { dhcp: false, lease: null, apipa: false, dnsServer: parseIp('10.10.20.10') });
    d.running.interfaces[NIC].ip = addr;
    d.running.defaultGateway = parseIp('10.10.10.254');
    net.commit({ silent: true });
  },
  fix: (net, site) => {
    const d = net.device(s(site.pc));
    Object.assign(d.hostNet!, { dhcp: true, dnsServer: null });
    renew(net, [s(site.pc)]);
  },
  explain: () => 'Someone had set the PC to a static address with the wrong default gateway (10.10.10.254). Local things worked, nothing beyond the subnet did. Back to DHCP fixed it.',
  hint: 'Can it reach its own subnet but nothing further? Compare its gateway with the real one.',
};

const staleDns: Fault = {
  id: 'stale-dns',
  difficulty: 'easy',
  weight: 2,
  desk: true,
  sites: (net, _o, people) => pcSites(net, people, (pc) => !!net.device(pc).hostNet && !net.device(pc).hostNet!.dnsCache['ledgerworks.cedarridge.local']),
  victims: (_n, _o, site) => [s(site.pc)],
  resources: (site) => [`pc:${site.pc}`, `dns:${site.pc}`],
  inject: (net, site) => {
    net.device(s(site.pc)).hostNet!.dnsCache['ledgerworks.cedarridge.local'] = { ip: parseIp('10.10.20.99')!, expires: net.time + 48 * 3600_000 };
  },
  fix: (net, site) => {
    delete net.device(s(site.pc)).hostNet!.dnsCache['ledgerworks.cedarridge.local'];
  },
  explain: () => 'The PC had an old address for LedgerWorks stuck in its DNS cache (from before the server moved). `ipconfig /flushdns` fixed it.',
  hint: 'Only one app, only this PC. How does the PC find that app\'s server?',
};

const printDriver: Fault = {
  id: 'print-driver',
  difficulty: 'easy',
  weight: 3,
  desk: true,
  sites: (net, _o, people) => pcSites(net, people, (pc) => net.device(pc).printDriver?.ok !== false),
  victims: (_n, _o, site) => [s(site.pc)],
  resources: (site) => [`pc:${site.pc}`, `driver:${site.pc}`],
  inject: (net, site) => {
    net.device(s(site.pc)).printDriver = { version: '6.4.0', ok: false };
  },
  fix: (net, site) => {
    net.device(s(site.pc)).printDriver = { version: '7.1.3', ok: true };
  },
  explain: () => 'A Windows update broke the old print driver on the PC. Reinstalling the current printer driver fixed it.',
  hint: 'Others can print to the same printer. What on this PC sits between the user and the printer?',
};

const apipa: Fault = {
  id: 'apipa',
  difficulty: 'trivial',
  weight: 4,
  sites: (net, _o, people) => pcSites(net, people, (pc) => !!net.device(pc).hostNet?.dhcp && !net.device(pc).hostNet!.apipa),
  victims: (_n, _o, site) => [s(site.pc)],
  resources: (site) => [`pc:${site.pc}`, `ip:${site.pc}`],
  inject: (net, site) => forceApipa(net, s(site.pc)),
  fix: (net, site) => renew(net, [s(site.pc)]),
  explain: () => 'The PC asked for an address during a short blip and never got one, so it sat on 169.254.x.x. A renew (or bouncing the port) got it a real address.',
  hint: '169.254 means DHCP didn\'t answer once. Is DHCP working for everyone else?',
};

// ---------------------------------------------------------------- a floor or the whole office

const floorSites = (net: Network, _office: Office, people: string[]): Site[] =>
  (['acc1', 'acc2'] as const).filter((sw) => people.some((pc) => floorOf(net, pc) === sw) && uplink(net, sw)).map((sw) => ({ sw, up: uplink(net, sw)! }));

const vlanPruned: Fault = {
  id: 'trunk-pruned',
  difficulty: 'moderate',
  weight: 3,
  sites: (net, office, people) =>
    floorSites(net, office, people)
      .filter((x) => {
        const sp = net.device(s(x.sw)).running.interfaces[s(x.up)].switchport;
        return !!sp && (sp.allowedVlans === 'all' || sp.allowedVlans.includes(10));
      })
      .map((x) => ({ ...x })),
  victims: (net, office, site) => sample(floorPeople(net, office, s(site.sw)), 6),
  configOn: (site) => s(site.sw),
  resources: (site) => [`trunk:${site.sw}`],
  inject: (net, site) => {
    const sp = net.device(s(site.sw)).running.interfaces[s(site.up)].switchport!;
    site.orig = sp.allowedVlans === 'all' ? 'all' : sp.allowedVlans.join(',');
    sp.allowedVlans = sp.allowedVlans === 'all' ? [1, 20, 30, 40, 99] : sp.allowedVlans.filter((v) => v !== 10);
    net.commit();
  },
  fix: (net, site) => {
    const sp = net.device(s(site.sw)).running.interfaces[s(site.up)].switchport!;
    sp.allowedVlans = site.orig === 'all' ? 'all' : s(site.orig).split(',').map(Number);
    net.commit();
  },
  explain: (_n, site) => `VLAN 10 had been removed from the allowed list on ${swName(site.sw)}'s uplink (${short(s(site.up))}), so the staff VLAN on that floor was cut off from the core. \`show interfaces trunk\` shows it; \`switchport trunk allowed vlan add 10\` fixed it.`,
  hint: 'A whole floor, one VLAN, and the uplink is up. What does the trunk actually carry?',
};

const uplinkShut: Fault = {
  id: 'uplink-shut',
  difficulty: 'moderate',
  weight: 1,
  sites: (net, office, people) => floorSites(net, office, people).map((x) => ({ ...x, core: net.peerOf(s(x.sw), s(x.up))!.iface })),
  victims: (net, office, site) => sample(floorPeople(net, office, s(site.sw)), 6),
  configOn: () => 'core1',
  resources: (site) => [`trunk:${site.sw}`],
  inject: (net, site) => {
    net.device('core1').running.interfaces[s(site.core)].shutdown = true;
    net.commit();
  },
  fix: (net, site) => {
    net.device('core1').running.interfaces[s(site.core)].shutdown = false;
    net.commit();
  },
  explain: (_n, site) => `The core's port to ${swName(site.sw)} (CR-CORE1 ${short(s(site.core))}) had been shut down, cutting the whole floor off. \`no shutdown\` on the core side fixed it.`,
  hint: 'The whole floor is out, including the switch\'s own management address. Look at the other end of its uplink.',
};

const vlanDeleted: Fault = {
  id: 'vlan-deleted',
  difficulty: 'hard',
  weight: 1,
  sites: (net, office, people) => floorSites(net, office, people).filter((x) => !!net.device(s(x.sw)).vlans[10] && net.device(s(x.sw)).running.vtp?.mode === 'transparent'),
  victims: (net, office, site) => sample(floorPeople(net, office, s(site.sw)), 6),
  configOn: (site) => s(site.sw),
  resources: (site) => [`vlan10:${site.sw}`],
  inject: (net, site) => {
    const d = net.device(s(site.sw));
    site.name = d.vlans[10]?.name ?? 'STAFF';
    delete d.vlans[10];
    net.commit();
  },
  fix: (net, site) => {
    net.device(s(site.sw)).vlans[10] = { name: s(site.name) };
    net.commit();
  },
  explain: (_n, site) => `VLAN 10 had been deleted from ${swName(site.sw)}'s VLAN database (\`no vlan 10\`). Every staff port on that floor went inactive. \`show vlan brief\` was missing it; \`vlan 10\` / \`name ${site.name}\` brought it back.`,
  hint: 'Ports are up and in VLAN 10 according to the config. Does VLAN 10 exist on that switch?',
};

const sviShut: Fault = {
  id: 'svi-shut',
  difficulty: 'moderate',
  weight: 1,
  sites: (net) => (net.device('core1').running.interfaces['Vlan10']?.shutdown === false ? [{ svi: 'Vlan10' }] : []),
  victims: (_n, office) => sample(staff(office), 6),
  configOn: () => 'core1',
  resources: () => ['svi:Vlan10'],
  inject: (net) => {
    net.device('core1').running.interfaces['Vlan10'].shutdown = true;
    net.commit();
  },
  fix: (net) => {
    net.device('core1').running.interfaces['Vlan10'].shutdown = false;
    net.commit();
  },
  explain: () => "CR-CORE1's interface Vlan10 (the staff gateway, 10.10.10.1) had been shut down. Everyone could still reach each other, nothing else. `no shutdown` on the SVI fixed it.",
  hint: 'Everyone, everything outside their own subnet. Can they ping their gateway?',
};

const sviIp: Fault = {
  id: 'svi-ip',
  difficulty: 'hard',
  weight: 1,
  sites: (net) => (net.device('core1').running.interfaces['Vlan10']?.ip ? [{ svi: 'Vlan10' }] : []),
  victims: (_n, office) => sample(staff(office), 6),
  configOn: () => 'core1',
  resources: () => ['svi:Vlan10'],
  inject: (net, site) => {
    const ifc = net.device('core1').running.interfaces['Vlan10'];
    site.addr = ifc.ip!.address;
    ifc.ip = { address: parseIp('10.10.11.1')!, prefix: 24 };
    net.commit();
  },
  fix: (net, site) => {
    net.device('core1').running.interfaces['Vlan10'].ip = { address: Number(site.addr), prefix: 24 };
    net.commit();
  },
  explain: () => "CR-CORE1's Vlan10 address had been changed to 10.10.11.1 (a typo during a change), so the PCs' gateway, 10.10.10.1, no longer existed. Restoring `ip address 10.10.10.1 255.255.255.0` fixed it.",
  hint: 'The gateway the PCs use: does anything answer on that address?',
};

const helperGone: Fault = {
  id: 'helper-gone',
  difficulty: 'moderate',
  weight: 3,
  sites: (net, _office, people) => ((net.device('core1').running.interfaces['Vlan10']?.helpers ?? []).length ? people.filter((pc) => net.device(pc).hostNet?.dhcp).slice(0, 2).map((pc, i, all) => ({ pc, pc2: all[1 - i] ?? pc })) : []),
  victims: (_n, _o, site) => [...new Set([s(site.pc), s(site.pc2)])],
  configOn: () => 'core1',
  resources: () => ['helper:Vlan10'],
  inject: (net, site) => {
    net.device('core1').running.interfaces['Vlan10'].helpers = [];
    net.commit();
    for (const pc of new Set([s(site.pc), s(site.pc2)])) {
      net.device(pc).powered = true;
      net.commit({ silent: true });
      dhcpRequest(net, pc);
    }
  },
  fix: (net, site) => {
    net.device('core1').running.interfaces['Vlan10'].helpers = [parseIp('10.10.20.10')!];
    net.commit();
    renew(net, [...new Set([s(site.pc), s(site.pc2)])]);
  },
  explain: () => "`ip helper-address 10.10.20.10` was missing from CR-CORE1's Vlan10, so DHCP broadcasts never reached the DC. Only PCs that renewed broke (169.254). Put the helper back and renew them.",
  hint: 'Only people who restarted are broken, with 169.254 addresses. How do DHCP requests get from VLAN 10 to the server?',
};

const ACL_TARGETS = [
  { svc: 'files', line: 'deny tcp any host 10.10.20.11 eq 445', port: 445, host: '10.10.20.11', what: 'the file server (SMB, tcp/445)' },
  { svc: 'ledger', line: 'deny tcp any host 10.10.20.12 eq 443', port: 443, host: '10.10.20.12', what: 'LedgerWorks (tcp/443)' },
  { svc: 'print', line: 'deny tcp any 10.10.30.0 0.0.0.255 eq 9100', port: 9100, host: '10.10.30.0', what: 'printing (tcp/9100)' },
];

const aclBlock: Fault = {
  id: 'acl-block',
  difficulty: 'hard',
  weight: 2,
  sites: (net) => (net.device('core1').running.interfaces['Vlan10']?.accessGroup?.in ? [] : ACL_TARGETS.map((_, i) => ({ t: i }))),
  victims: (_n, office) => sample(staff(office), 6),
  configOn: () => 'core1',
  resources: () => ['acl:Vlan10:in'],
  inject: (net, site) => {
    const t = ACL_TARGETS[Number(site.t)];
    const core = net.device('core1').running;
    const wild = t.host.endsWith('.0') ? 255 : 0;
    core.acls = {
      ...core.acls,
      'STAFF-IN': {
        name: 'STAFF-IN',
        type: 'extended',
        named: true,
        entries: [
          { seq: 5, remark: 'Lock down staff VLAN - phase 1' },
          { seq: 10, action: 'deny', proto: 'tcp', src: { addr: 0, wildcard: 0xffffffff }, dst: { addr: parseIp(t.host)!, wildcard: wild }, dstPort: { op: 'eq', ports: [t.port] } },
          { seq: 20, action: 'permit', proto: 'ip', src: { addr: parseIp('10.10.10.0')!, wildcard: 255 }, dst: { addr: 0, wildcard: 0xffffffff } },
        ],
      },
    };
    core.interfaces['Vlan10'].accessGroup = { in: 'STAFF-IN' };
    net.commit();
  },
  fix: (net) => {
    const core = net.device('core1').running;
    delete core.interfaces['Vlan10'].accessGroup;
    if (core.acls) delete core.acls['STAFF-IN'];
    net.commit();
  },
  explain: (_n, site) => `A half-finished "lockdown" ACL, STAFF-IN, was applied inbound on CR-CORE1 Vlan10 and its first line blocked ${ACL_TARGETS[Number(site.t)].what} for the whole staff VLAN. \`show ip interface vlan 10\` and the ACL's hit counters show it. Removing \`ip access-group STAFF-IN in\` (or fixing the line) fixed it.`,
  hint: 'One service, everyone, and ping still works. Is something filtering traffic on the way?',
};

const serverPort: Fault = {
  id: 'server-port',
  difficulty: 'moderate',
  weight: 2,
  sites: (net) =>
    [
      { srv: 'fs01', port: 'FastEthernet0/2' },
      { srv: 'app01', port: 'FastEthernet0/3' },
    ].filter((x) => !net.device('core1').running.interfaces[x.port].shutdown),
  victims: (_n, office) => sample(staff(office), 6),
  configOn: () => 'core1',
  resources: (site) => [`port:core1:${site.port}`],
  inject: (net, site) => {
    net.device('core1').running.interfaces[s(site.port)].shutdown = true;
    net.commit();
  },
  fix: (net, site) => {
    net.device('core1').running.interfaces[s(site.port)].shutdown = false;
    net.commit();
  },
  explain: (_n, site) => `CR-CORE1 ${short(s(site.port))}, the port to ${site.srv === 'fs01' ? 'CR-FS01 (the file server)' : 'CR-APP01 (LedgerWorks)'}, had been shut down. \`no shutdown\` fixed it.`,
  hint: 'One server is unreachable for everyone. Is its switch port up?',
};

const serverVlan: Fault = {
  id: 'server-vlan',
  difficulty: 'moderate',
  weight: 1,
  sites: (net) =>
    [
      { srv: 'fs01', port: 'FastEthernet0/2' },
      { srv: 'app01', port: 'FastEthernet0/3' },
    ].filter((x) => net.device('core1').running.interfaces[x.port].switchport?.accessVlan === 20),
  victims: (_n, office) => sample(staff(office), 6),
  configOn: () => 'core1',
  resources: (site) => [`port:core1:${site.port}`],
  inject: (net, site) => {
    net.device('core1').running.interfaces[s(site.port)].switchport!.accessVlan = 10;
    net.commit();
  },
  fix: (net, site) => {
    net.device('core1').running.interfaces[s(site.port)].switchport!.accessVlan = 20;
    net.commit();
  },
  explain: (_n, site) => `CR-CORE1 ${short(s(site.port))} (to ${site.srv === 'fs01' ? 'CR-FS01' : 'CR-APP01'}) had been moved into VLAN 10, so the server's 10.10.20.x address sat on the wrong subnet. Back to VLAN 20 fixed it.`,
  hint: 'The server\'s port is up, but nobody can reach it, not even from the core. Which VLAN is that port in?',
};

const printerPortShut: Fault = {
  id: 'printer-port',
  difficulty: 'easy',
  weight: 3,
  sites: (net, _office, people) =>
    (['acc1', 'acc2'] as const)
      .filter((sw) => people.some((pc) => floorOf(net, pc) === sw) && !net.device(sw).running.interfaces['FastEthernet0/20'].shutdown && net.peerOf(sw, 'FastEthernet0/20'))
      .map((sw) => ({ sw })),
  victims: (net, office, site) => sample(floorPeople(net, office, s(site.sw)), 5),
  configOn: (site) => s(site.sw),
  resources: (site) => [`port:${site.sw}:FastEthernet0/20`, `printer:${site.sw}`],
  inject: (net, site) => {
    net.device(s(site.sw)).running.interfaces['FastEthernet0/20'].shutdown = true;
    net.commit();
  },
  fix: (net, site) => {
    net.device(s(site.sw)).running.interfaces['FastEthernet0/20'].shutdown = false;
    net.commit();
  },
  explain: (_n, site) => `The copy room printer's port, ${swName(site.sw)} Fa0/20, had been shut down. \`no shutdown\` fixed it.`,
  hint: 'Only printing, only one floor. Is the printer reachable at all?',
};

const printerCable: Fault = {
  id: 'printer-cable',
  difficulty: 'easy',
  weight: 2,
  desk: true,
  sites: (net, _office, people) =>
    [
      { prn: 'prn1', sw: 'acc1' },
      { prn: 'prn2', sw: 'acc2' },
    ].filter((x) => people.some((pc) => floorOf(net, pc) === x.sw) && net.linkAt(x.prn, 'FastEthernet0')?.cable === 'ok'),
  victims: (net, office, site) => sample(floorPeople(net, office, s(site.sw)), 5),
  resources: (site) => [`printer:${site.sw}`],
  inject: (net, site) => {
    net.linkAt(s(site.prn), 'FastEthernet0')!.cable = 'unplugged';
    net.commit();
  },
  fix: (net, site) => {
    const l = net.linkAt(s(site.prn), 'FastEthernet0');
    if (l) l.cable = 'ok';
    net.commit();
  },
  explain: () => 'The network cable had worked loose at the back of the printer. Reseating it at the printer fixed it.',
  hint: 'The printer\'s switch port is down. Go and look at the printer.',
};

const defaultRoute: Fault = {
  id: 'default-route',
  difficulty: 'moderate',
  weight: 1,
  sites: (net) => (net.device('rtr1').running.staticRoutes.some((r) => r.prefix === 0) ? [{ rtr: 'rtr1' }] : []),
  victims: (_n, office) => sample(staff(office), 6),
  configOn: () => 'rtr1',
  resources: () => ['route:default'],
  inject: (net, site) => {
    const r = net.device('rtr1').running;
    const d = r.staticRoutes.find((x) => x.prefix === 0)!;
    site.route = JSON.stringify(d);
    r.staticRoutes = r.staticRoutes.filter((x) => x !== d);
    net.commit();
  },
  fix: (net, site) => {
    net.device('rtr1').running.staticRoutes.push(JSON.parse(s(site.route)));
    net.commit();
  },
  explain: () => "CR-RTR1's static default route to the ISP had been removed, so nothing knew the way to the internet (and OSPF stopped advertising a default to the core). Putting back `ip route 0.0.0.0 0.0.0.0 203.0.113.1` fixed it.",
  hint: 'Internet only, everyone. Follow a packet for 8.8.8.8 hop by hop: where does it stop?',
};

const wrongNextHop: Fault = {
  id: 'default-next-hop',
  difficulty: 'hard',
  weight: 1,
  sites: (net) => (net.device('rtr1').running.staticRoutes.some((r) => r.prefix === 0 && r.nextHop !== null) ? [{ rtr: 'rtr1' }] : []),
  victims: (_n, office) => sample(staff(office), 6),
  configOn: () => 'rtr1',
  resources: () => ['route:default'],
  inject: (net, site) => {
    const d = net.device('rtr1').running.staticRoutes.find((x) => x.prefix === 0)!;
    site.hop = d.nextHop;
    d.nextHop = parseIp('203.0.113.9');
    net.commit();
  },
  fix: (net, site) => {
    const d = net.device('rtr1').running.staticRoutes.find((x) => x.prefix === 0);
    if (d) d.nextHop = Number(site.hop);
    net.commit();
  },
  explain: () => "CR-RTR1's default route pointed at 203.0.113.9 instead of the ISP's 203.0.113.1 (a typo in a change). Nothing answers ARP for .9, so internet traffic died at the router. Correcting the next hop fixed it.",
  hint: 'The router has a default route. Does its next hop exist?',
};

// ---------------------------------------------------------------- hardware that wears out

const INFRA_LINKS = [
  { dev: 'acc1', port: 'GigabitEthernet0/1', what: "CR-ACC1's uplink to the core", scope: 'floor1' },
  { dev: 'acc2', port: 'GigabitEthernet0/1', what: "CR-ACC2's uplink to the core", scope: 'floor2' },
  { dev: 'core1', port: 'FastEthernet0/2', what: 'the cable from CR-CORE1 to CR-FS01', scope: 'staff' },
  { dev: 'core1', port: 'FastEthernet0/3', what: 'the cable from CR-CORE1 to CR-APP01', scope: 'staff' },
  { dev: 'core1', port: 'FastEthernet0/24', what: 'the cable between CR-CORE1 and CR-RTR1', scope: 'staff' },
  { dev: 'acc1', port: 'FastEthernet0/20', what: "the 1st floor printer's cable", scope: 'floor1' },
  { dev: 'acc2', port: 'FastEthernet0/20', what: "the 2nd floor printer's cable", scope: 'floor2' },
];

const infraCable: Fault = {
  id: 'infra-cable',
  difficulty: 'moderate',
  weight: 1,
  hardware: true,
  sites: (net) =>
    INFRA_LINKS.filter((l) => net.linkAt(l.dev, l.port)?.cable === 'ok' && net.isUp(l.dev, l.port)).map((l) => ({ dev: l.dev, port: l.port, what: l.what, scope: l.scope })),
  victims: (net, office, site) => sample(site.scope === 'staff' ? staff(office) : floorPeople(net, office, site.scope === 'floor1' ? 'acc1' : 'acc2'), 6),
  resources: (site) => [`cable:${site.dev}:${site.port}`],
  inject: (net, site) => {
    net.linkAt(s(site.dev), s(site.port))!.cable = 'cut';
    net.commit();
  },
  fix: (net, site) => {
    const l = net.linkAt(s(site.dev), s(site.port));
    if (l) l.cable = 'ok';
    net.commit();
  },
  repaired: (net, site) => net.linkAt(s(site.dev), s(site.port))?.cable !== 'cut',
  explain: (_n, site) => `${String(site.what).charAt(0).toUpperCase() + String(site.what).slice(1)} failed: the link was down at both ends with nothing wrong in the config (${swName(site.dev)} ${short(s(site.port))} notconnect). Replacing the patch cable fixed it.`,
  hint: 'Several people, one direction of the network. Which link is down, and is anything wrong with its config?',
};

const nicDead: Fault = {
  id: 'nic-dead',
  difficulty: 'easy',
  weight: 1,
  desk: true,
  hardware: true,
  sites: (net, _o, people) => pcSites(net, people, (pc) => !!net.device(pc).nic && !net.device(pc).nic!.failed && !net.device(pc).nic!.disabled && net.device(pc).nic!.driver === 'ok'),
  victims: (_n, _o, site) => [s(site.pc)],
  resources: (site) => [`pc:${site.pc}`, `nic:${site.pc}`],
  inject: (net, site) => {
    net.device(s(site.pc)).nic!.failed = true;
    net.commit();
  },
  fix: (net, site) => {
    Object.assign(net.device(s(site.pc)).nic!, { failed: false, driver: 'ok', version: CURRENT_NIC_DRIVER, disabled: false });
    net.commit();
    renew(net, [s(site.pc)]);
  },
  repaired: (net, site) => !net.device(s(site.pc)).nic?.failed,
  explain: () => "The PC's network card died (Device Manager: Code 43). Cable and switch port were fine. Swapping in a spare card fixed it.",
  hint: 'The switch port is down, the cable is good. What does the PC think of its own network card?',
};

const portDead: Fault = {
  id: 'port-dead',
  difficulty: 'moderate',
  weight: 1,
  hardware: true,
  sites: (net, _o, people) =>
    pcSites(net, people, (_pc, sw, port) => !net.device(sw).deadPorts?.includes(port) && Object.keys(net.device(sw).hardware).some((p) => p.startsWith('FastEthernet') && !net.linkAt(sw, p) && !net.device(sw).deadPorts?.includes(p))),
  victims: (_n, _o, site) => [s(site.pc)],
  resources: (site) => [`port:${site.sw}:${site.port}`, `pc:${site.pc}`],
  inject: (net, site) => {
    const d = net.device(s(site.sw));
    d.deadPorts = [...(d.deadPorts ?? []), s(site.port)];
    net.commit();
  },
  fix: (net, site) => {
    // A senior moves the cable to a free port with the same settings. The dead port stays dead.
    const sw = net.device(s(site.sw));
    const free = Object.keys(sw.hardware).find((p) => p.startsWith('FastEthernet') && !net.linkAt(sw.id, p) && !sw.deadPorts?.includes(p));
    if (!free) return;
    const old = sw.running.interfaces[s(site.port)];
    const nu = sw.running.interfaces[free];
    if (old.switchport && nu.switchport) nu.switchport = { ...structuredClone(old.switchport) };
    nu.shutdown = false;
    nu.description = old.description;
    net.disconnect(s(site.pc), NIC);
    net.connect(s(site.pc), NIC, sw.id, free);
    site.moved = free;
    net.commit();
    renew(net, [s(site.pc)]);
  },
  repaired: (net, site) => {
    const peer = net.peerOf(s(site.pc), NIC);
    return !!peer && !net.device(peer.device).deadPorts?.includes(peer.iface);
  },
  explain: (_n, site) =>
    `${swName(site.sw)} ${short(s(site.port))} died: no link with a good cable and a good PC, and nothing wrong in its config. The fix is moving the desk's patch cable to a free port and configuring it the same way (VLAN 10, PortFast), then relabeling it.`,
  hint: 'Cable fine, PC fine, config fine, still no link. Try the cable in another port.',
};

export const FAULTS: Fault[] = [
  portShut,
  wrongVlan,
  accessTrunk,
  cableOut,
  cableBad,
  nicOff,
  driverOld,
  staticGateway,
  staleDns,
  printDriver,
  apipa,
  vlanPruned,
  uplinkShut,
  vlanDeleted,
  sviShut,
  sviIp,
  helperGone,
  aclBlock,
  serverPort,
  serverVlan,
  printerPortShut,
  printerCable,
  defaultRoute,
  wrongNextHop,
  infraCable,
  nicDead,
  portDead,
];

export function faultById(id: string): Fault {
  const f = FAULTS.find((x) => x.id === id);
  if (!f) throw new Error(`Unknown fault ${id}`);
  return f;
}
