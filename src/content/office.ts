// Season 1: Cedar Ridge Accounting — a 20-person office in one building, two floors.
//
//   INTERNET (8.8.8.8) -- ISP-RTR (not ours) -- CR-RTR1 -- CR-CORE1 (L3 switch, inter-VLAN routing)
//                                                            |-- CR-DC01 / CR-FS01 / CR-APP01  (VLAN 20)
//                                                            |-- NOC-PC                        (VLAN 99)
//                                                            |-- CR-ACC1 (1st floor) -- WS01-WS10, CR-PRN1
//                                                            '-- CR-ACC2 (2nd floor) -- WS11-WS20, CR-PRN2
//
// VLAN 10 STAFF 10.10.10.0/24 | VLAN 20 SERVERS 10.10.20.0/24 | VLAN 30 PRINTERS 10.10.30.0/24 | VLAN 99 MGMT 10.10.99.0/24

import { initLabels } from '../game/physical';
import { anyImage, installImage, RELEASES } from '../sim/images';
import { createDevice, DEFAULT_ADMIN_USER, defaultInterfaceConfig } from '../sim/devices';
import type { HostOptions } from '../sim/host';
import { maskToPrefix, parseIp } from '../sim/ip';
import { dhcpRequest } from '../sim/dhcp';
import { DOMAIN } from '../sim/dns';
import { newBgp, newOspf } from '../sim/control/config';
import { Network } from '../sim/network';
import type { Device, StaticRoute } from '../sim/types';

export const COMPANY = 'Cedar Ridge Accounting';
export const NOC_PC_KEY = 'nocadmin@NOC-PC';
export const NOC_PC_IP = '10.10.99.50';
/** The NOC's monitoring system polls with SNMP v2c, read-only, using this community. */
export const SNMP_COMMUNITY = 'cedar-mon';

export const VLANS = [
  { id: 10, name: 'STAFF', subnet: '10.10.10.0/24', gateway: '10.10.10.1', purpose: 'Staff workstations' },
  { id: 20, name: 'SERVERS', subnet: '10.10.20.0/24', gateway: '10.10.20.1', purpose: 'Servers' },
  { id: 30, name: 'PRINTERS', subnet: '10.10.30.0/24', gateway: '10.10.30.1', purpose: 'Printers' },
  { id: 40, name: 'GUEST', subnet: '10.10.40.0/24', gateway: '10.10.40.1', purpose: 'Conference room and guest laptops. DHCP from CR-CORE1, internet only' },
  { id: 99, name: 'MGMT', subnet: '10.10.99.0/24', gateway: '10.10.99.1', purpose: 'Switch management and the NOC PC' },
];

export interface Person {
  name: string;
  title: string;
  department: 'Admin' | 'Tax' | 'Audit' | 'Partners';
  /** How they behave in chat: helpful, impatient, clueless, or a ghost who rarely replies. */
  persona: 'helpful' | 'impatient' | 'clueless' | 'ghost';
  desk: string;
  /** PC hostname as originally installed. */
  pc: string;
  /** Stable device id of their PC (hostnames can be renamed). */
  pcId: string;
}

const STAFF: Omit<Person, 'pc' | 'desk' | 'pcId'>[] = [
  { name: 'Maria Okafor', title: 'Receptionist', department: 'Admin', persona: 'helpful' },
  { name: 'Tom Brennan', title: 'Office Manager', department: 'Admin', persona: 'impatient' },
  { name: 'Jenna Liu', title: 'Tax Manager', department: 'Tax', persona: 'helpful' },
  { name: 'Marcus Hill', title: 'Senior Tax Associate', department: 'Tax', persona: 'clueless' },
  { name: 'Sofia Ramirez', title: 'Tax Associate', department: 'Tax', persona: 'helpful' },
  { name: 'Derek Chung', title: 'Tax Associate', department: 'Tax', persona: 'ghost' },
  { name: 'Priya Natarajan', title: 'Tax Associate', department: 'Tax', persona: 'helpful' },
  { name: 'Alan Brooks', title: 'Tax Associate', department: 'Tax', persona: 'impatient' },
  { name: 'Keisha Moore', title: 'Bookkeeper', department: 'Tax', persona: 'helpful' },
  { name: 'Ben Ortiz', title: 'Seasonal Tax Preparer', department: 'Tax', persona: 'clueless' },
  { name: 'Rachel Stein', title: 'Audit Manager', department: 'Audit', persona: 'impatient' },
  { name: 'Omar Haddad', title: 'Senior Auditor', department: 'Audit', persona: 'helpful' },
  { name: 'Lena Fischer', title: 'Auditor', department: 'Audit', persona: 'helpful' },
  { name: 'Chris Duval', title: 'Auditor', department: 'Audit', persona: 'clueless' },
  { name: 'Hannah Kim', title: 'Staff Auditor', department: 'Audit', persona: 'helpful' },
  { name: 'Victor Petrov', title: 'Staff Auditor', department: 'Audit', persona: 'ghost' },
  { name: 'Grace Thompson', title: 'HR Coordinator', department: 'Admin', persona: 'helpful' },
  { name: 'Sam Wallace', title: 'Billing Specialist', department: 'Admin', persona: 'clueless' },
  { name: 'Diane Cedar', title: 'Managing Partner', department: 'Partners', persona: 'impatient' },
  { name: 'Robert Ridge', title: 'Partner', department: 'Partners', persona: 'ghost' },
];

export interface ServerInfo {
  id: string;
  hostname: string;
  ip: string;
  role: string;
}

export const SERVERS: ServerInfo[] = [
  { id: 'dc01', hostname: 'CR-DC01', ip: '10.10.20.10', role: 'Domain controller, DNS, DHCP' },
  { id: 'fs01', hostname: 'CR-FS01', ip: '10.10.20.11', role: 'File server (client files, S: drive)' },
  { id: 'app01', hostname: 'CR-APP01', ip: '10.10.20.12', role: 'LedgerWorks practice management' },
];

export const PRINTERS = [
  { id: 'prn1', hostname: 'CR-PRN1', ip: '10.10.30.21', location: '1st floor copy room', switchId: 'acc1', port: 'FastEthernet0/20' },
  { id: 'prn2', hostname: 'CR-PRN2', ip: '10.10.30.22', location: '2nd floor copy room', switchId: 'acc2', port: 'FastEthernet0/20' },
];

export interface NetworkDeviceInfo {
  id: string;
  hostname: string;
  model: string;
  mgmtIp: string;
  location: string;
  role: string;
}

export const NETWORK_DEVICES: NetworkDeviceInfo[] = [
  { id: 'rtr1', hostname: 'CR-RTR1', model: 'NS-R4300', mgmtIp: '10.0.0.1', location: 'Server room', role: 'Edge router to ISP' },
  { id: 'core1', hostname: 'CR-CORE1', model: 'NS-S3600', mgmtIp: '10.10.99.1', location: 'Server room', role: 'Core L3 switch, routes between VLANs' },
  { id: 'acc1', hostname: 'CR-ACC1', model: 'NS-S2900', mgmtIp: '10.10.99.11', location: '1st floor IDF closet', role: 'Access switch, 1st floor' },
  { id: 'acc2', hostname: 'CR-ACC2', model: 'NS-S2900', mgmtIp: '10.10.99.12', location: '2nd floor IDF closet', role: 'Access switch, 2nd floor' },
];

export const ISP = {
  name: 'Brightline Fiber',
  circuit: 'BLF-88213-CR',
  wanIp: '203.0.113.2/30',
  gateway: '203.0.113.1',
  support: '1-800-555-0142',
  /** Brightline's AS, and the private AS they assigned us for BGP. */
  asn: 64500,
  ourAsn: 65010,
};

/** Where things are, for walking and for the map. */
export interface Zone {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const ZONES: Zone[] = [
  { id: 'outside', label: 'Outside (ISP)', x: 470, y: 6, w: 360, h: 180 },
  { id: 'server', label: 'Server room', x: 60, y: 194, w: 1080, h: 168 },
  { id: 'floor1', label: '1st floor', x: 60, y: 372, w: 525, h: 326 },
  { id: 'floor2', label: '2nd floor', x: 615, y: 372, w: 525, h: 326 },
];

export interface Office {
  net: Network;
  layout: Record<string, { x: number; y: number; zone: string }>;
  people: Person[];
  /** The device the player starts at. */
  home: string;
  hostOptions: Record<string, HostOptions>;
  /** The tutorial incident. */
  tutorial: { person: Person; pcId: string; switchId: string; port: string };
}

function ip(text: string) {
  const [addr, mask] = text.split(' ');
  return { address: parseIp(addr)!, prefix: maskToPrefix(parseIp(mask)!)! };
}

function route(net: string, mask: string, nextHop: string): StaticRoute {
  return { network: parseIp(net)!, prefix: maskToPrefix(parseIp(mask)!)!, nextHop: parseIp(nextHop), exitIf: null, distance: 1 };
}

function access(sw: Device, port: string, vlan: number, description: string): void {
  const ifc = sw.running.interfaces[port];
  ifc.switchport!.mode = 'access';
  ifc.switchport!.accessVlan = vlan;
  ifc.description = description;
}

function trunk(sw: Device, port: string, description: string): void {
  const ifc = sw.running.interfaces[port];
  if (sw.kind === 'l3switch') ifc.switchport!.trunkEncapsulation = 'dot1q';
  ifc.switchport!.mode = 'trunk';
  ifc.description = description;
}

function svi(sw: Device, vlan: number, addr: string, description: string): void {
  const ifc = sw.running.interfaces[`Vlan${vlan}`] ?? defaultInterfaceConfig(`Vlan${vlan}`, sw.kind, false);
  ifc.shutdown = false;
  ifc.ip = ip(addr);
  ifc.description = description;
  sw.running.interfaces[`Vlan${vlan}`] = ifc;
}

function host(net: Network, id: string, model: string, hostname: string, addr: string, gateway: string): Device {
  const d = net.addDevice(createDevice(id, model, hostname));
  const nic = Object.keys(d.hardware)[0];
  d.running.interfaces[nic].ip = ip(`${addr} 255.255.255.0`);
  d.running.defaultGateway = parseIp(gateway);
  return d;
}

function nic(d: Device): string {
  return Object.keys(d.hardware)[0];
}

/** The predecessor set up SSH with the NOC PC's key trusted everywhere. */
function inheritedSsh(device: Device, keySerial: number): void {
  const cfg = device.running;
  cfg.domainName = 'cedarridge.local';
  cfg.crypto = { bits: 2048, serial: keySerial };
  cfg.ssh.version = 2;
  cfg.users[DEFAULT_ADMIN_USER] = { privilege: 15, secret: 'Ledger!Mike2019', password: null };
  cfg.authorizedKeys = [{ user: DEFAULT_ADMIN_USER, key: NOC_PC_KEY }];
  cfg.lines.vty.login = 'local';
  cfg.lines.vty.transport = { ssh: true, telnet: false };
  cfg.lines.con.loggingSynchronous = true;
  cfg.bannerMotd = `Authorized access only - ${COMPANY}`;
}

export const TUTORIAL_PC = 'ws07';

export function buildOffice(seed: number | string = 'cedar-ridge'): Office {
  const net = new Network(seed);
  const layout: Office['layout'] = {};
  const place = (id: string, x: number, y: number, zone: string) => (layout[id] = { x, y, zone });

  // --- Outside: the ISP and "the internet" -------------------------------------------
  const internet = host(net, 'internet', 'NS-SRV', 'INTERNET', '8.8.8.8', '8.8.8.1');
  internet.managed = false;
  const isp = net.addDevice(createDevice('isp', 'NS-R4300', 'ISP-RTR'));
  isp.managed = false;
  isp.running.interfaces['GigabitEthernet0/0'].shutdown = false;
  isp.running.interfaces['GigabitEthernet0/0'].ip = ip('203.0.113.1 255.255.255.252');
  isp.running.interfaces['GigabitEthernet0/1'].shutdown = false;
  isp.running.interfaces['GigabitEthernet0/1'].ip = ip('8.8.8.1 255.255.255.0');
  // The ISP knows nothing about our private 10.x space: only NAT on CR-RTR1 gets replies home.
  isp.running.lines.vty.transport = { ssh: false, telnet: false };
  // Brightline is ready to peer BGP with us (our AS would be 65010) and send a default route. We don't, yet.
  isp.running.routing = {
    ospf: [],
    eigrp: [],
    rip: null,
    bgp: {
      ...newBgp(ISP.asn),
      routerId: parseIp('203.0.113.1'),
      neighbors: { '203.0.113.2': { remoteAs: ISP.ourAsn, description: COMPANY, defaultOriginate: true } },
      networks: [{ addr: parseIp('8.8.8.0')!, prefix: 24 }],
    },
  };
  place('internet', 650, 40, 'outside');
  place('isp', 650, 128, 'outside');

  // --- Server room ---------------------------------------------------------------------
  const rtr = net.addDevice(createDevice('rtr1', 'NS-R4300', 'CR-RTR1'));
  const g0 = rtr.running.interfaces['GigabitEthernet0/0'];
  g0.shutdown = false;
  g0.description = 'Link to CR-CORE1 Fa0/24';
  g0.ip = ip('10.0.0.1 255.255.255.252');
  const g1 = rtr.running.interfaces['GigabitEthernet0/1'];
  g1.shutdown = false;
  g1.description = `WAN - ${ISP.name} circuit ${ISP.circuit}`;
  g1.ip = ip('203.0.113.2 255.255.255.252');
  // A static default to the ISP, handed to the core through OSPF; internal routes come back the same way.
  rtr.running.staticRoutes.push(route('0.0.0.0', '0.0.0.0', '203.0.113.1'));
  rtr.running.routing = {
    ospf: [
      {
        ...newOspf(1),
        routerId: parseIp('10.255.255.1'),
        networks: [{ addr: parseIp('10.0.0.0')!, wildcard: parseIp('0.0.0.3')!, area: 0 }],
        defaultOriginate: { always: false },
      },
    ],
    eigrp: [],
    rip: null,
    bgp: null,
  };
  // PAT: every inside address shares the WAN address on the way out.
  g0.nat = 'inside';
  g1.nat = 'outside';
  rtr.running.acls = {
    '1': { name: '1', type: 'standard', named: false, entries: [{ seq: 10, action: 'permit', src: { addr: parseIp('10.10.0.0')!, wildcard: parseIp('0.0.255.255')! } }] },
  };
  rtr.running.nat = { pools: {}, rules: [{ kind: 'dynamic', acl: '1', iface: 'GigabitEthernet0/1', overload: true }] };
  place('rtr1', 650, 228, 'server');

  const core = net.addDevice(createDevice('core1', 'NS-S3600', 'CR-CORE1'));
  core.running.ipRouting = true;
  for (const v of VLANS) core.vlans[v.id] = { name: v.name };
  const uplink = core.running.interfaces['FastEthernet0/24'];
  uplink.switchport = null;
  uplink.description = 'Routed link to CR-RTR1 Gi0/0';
  uplink.ip = ip('10.0.0.2 255.255.255.252');
  svi(core, 10, '10.10.10.1 255.255.255.0', 'STAFF gateway');
  svi(core, 20, '10.10.20.1 255.255.255.0', 'SERVERS gateway');
  svi(core, 30, '10.10.30.1 255.255.255.0', 'PRINTERS gateway');
  svi(core, 40, '10.10.40.1 255.255.255.0', 'GUEST gateway');
  svi(core, 99, '10.10.99.1 255.255.255.0', 'MGMT gateway');
  // Guests get the internet and nothing internal. DHCP for them comes from the core itself.
  const any = { addr: 0, wildcard: 0xffffffff };
  const guests = { addr: parseIp('10.10.40.0')!, wildcard: 255 };
  core.running.acls = {
    'GUEST-IN': {
      name: 'GUEST-IN',
      type: 'extended',
      named: true,
      entries: [
        { seq: 5, remark: 'Guests: internet only' },
        { seq: 10, action: 'permit', proto: 'udp', src: any, dst: any, dstPort: { op: 'eq', ports: [67] } },
        { seq: 20, action: 'permit', proto: 'icmp', src: guests, dst: { addr: parseIp('10.10.40.1')!, wildcard: 0 } },
        { seq: 25, action: 'permit', proto: 'icmp', src: guests, dst: { addr: parseIp('10.10.99.0')!, wildcard: 255 }, icmpType: 'echo-reply' },
        { seq: 30, action: 'deny', proto: 'ip', src: guests, dst: { addr: parseIp('10.0.0.0')!, wildcard: parseIp('0.255.255.255')! } },
        { seq: 40, action: 'permit', proto: 'ip', src: guests, dst: any },
      ],
    },
  };
  core.running.interfaces['Vlan40'].accessGroup = { in: 'GUEST-IN' };
  core.running.dhcpExcluded = [[parseIp('10.10.40.1')!, parseIp('10.10.40.9')!]];
  core.running.dhcpPools = {
    GUEST: {
      network: parseIp('10.10.40.0')!,
      prefix: 24,
      defaultRouter: [parseIp('10.10.40.1')!],
      dnsServer: [parseIp('8.8.8.8')!],
      domainName: null,
      leaseMs: 8 * 3600_000,
    },
  };
  // OSPF area 0 with CR-RTR1 over the routed uplink; every VLAN is advertised, only the uplink talks OSPF.
  core.running.routing = {
    ospf: [
      {
        ...newOspf(1),
        routerId: parseIp('10.255.255.2'),
        networks: [
          { addr: parseIp('10.0.0.0')!, wildcard: parseIp('0.0.0.3')!, area: 0 },
          { addr: parseIp('10.10.0.0')!, wildcard: parseIp('0.0.255.255')!, area: 0 },
        ],
        passive: { passiveDefault: true, exceptions: ['FastEthernet0/24'] },
      },
    ],
    eigrp: [],
    rip: null,
    bgp: null,
  };
  trunk(core, 'GigabitEthernet0/1', 'Trunk to CR-ACC1');
  trunk(core, 'GigabitEthernet0/2', 'Trunk to CR-ACC2');
  place('core1', 650, 302, 'server');

  SERVERS.forEach((s, i) => {
    host(net, s.id, 'NS-SRV', s.hostname, s.ip, '10.10.20.1');
    access(core, `FastEthernet0/${i + 1}`, 20, s.hostname);
    place(s.id, 150 + i * 140, 270, 'server');
  });

  const noc = host(net, 'noc', 'NS-PC', 'NOC-PC', '10.10.99.50', '10.10.99.1');
  access(core, 'FastEthernet0/10', 99, 'NOC-PC');
  place('noc', 1020, 270, 'server');

  // --- Floors --------------------------------------------------------------------------
  const people: Person[] = [];
  const floors = [
    { id: 'acc1', hostname: 'CR-ACC1', mgmt: '10.10.99.11', coreTrunk: 'GigabitEthernet0/1', zone: 'floor1', x: 322, staff: STAFF.slice(0, 10), first: 1 },
    { id: 'acc2', hostname: 'CR-ACC2', mgmt: '10.10.99.12', coreTrunk: 'GigabitEthernet0/2', zone: 'floor2', x: 877, staff: STAFF.slice(10), first: 11 },
  ];
  for (const f of floors) {
    const sw = net.addDevice(createDevice(f.id, 'NS-S2900', f.hostname));
    for (const v of VLANS) sw.vlans[v.id] = { name: v.name };
    trunk(sw, 'GigabitEthernet0/1', `Uplink to CR-CORE1 ${f.coreTrunk === 'GigabitEthernet0/1' ? 'Gi0/1' : 'Gi0/2'}`);
    svi(sw, 99, `${f.mgmt} 255.255.255.0`, 'Management');
    sw.running.interfaces['Vlan1'].shutdown = true;
    sw.running.defaultGateway = parseIp('10.10.99.1');
    place(f.id, f.x, 428, f.zone);
    net.connect('core1', f.coreTrunk, f.id, 'GigabitEthernet0/1');

    f.staff.forEach((p, i) => {
      const n = f.first + i;
      const id = `ws${String(n).padStart(2, '0')}`;
      const hostname = `CR-WS${String(n).padStart(2, '0')}`;
      const floor = f.zone === 'floor1' ? 1 : 2;
      const desk = `${floor}-${String(i + 1).padStart(2, '0')}`;
      const ws = host(net, id, 'NS-PC', hostname, `10.10.10.${100 + n}`, '10.10.10.1');
      const port = `FastEthernet0/${i + 1}`;
      access(sw, port, 10, `Desk ${desk} ${p.name.split(' ')[0]}`);
      net.connect(id, nic(ws), f.id, port);
      people.push({ ...p, desk, pc: hostname, pcId: id });
      const col = i % 5;
      const row = Math.floor(i / 5);
      place(id, f.x - 220 + col * 110, 540 + row * 90, f.zone);
    });
  }
  for (const p of PRINTERS) {
    host(net, p.id, 'NS-PRN', p.hostname, p.ip, '10.10.30.1');
    access(net.device(p.switchId), p.port, 30, p.hostname);
    net.connect(p.id, 'FastEthernet0', p.switchId, p.port);
    place(p.id, layout[p.switchId].x + 200, 428, layout[p.switchId].zone);
  }

  // The shared PC in the 1st-floor conference room, on the guest VLAN.
  const conf = host(net, 'conf1', 'NS-PC', 'CR-CONF1', '10.10.40.10', '10.10.40.1');
  access(net.device('acc1'), 'FastEthernet0/21', 40, 'Conference room');
  net.connect('conf1', nic(conf), 'acc1', 'FastEthernet0/21');
  place('conf1', 120, 428, 'floor1');

  // --- Cabling in the server room ------------------------------------------------------
  net.connect('internet', nic(internet), 'isp', 'GigabitEthernet0/1');
  net.connect('isp', 'GigabitEthernet0/0', 'rtr1', 'GigabitEthernet0/1');
  net.connect('rtr1', 'GigabitEthernet0/0', 'core1', 'FastEthernet0/24');
  // A second uplink to the 1st floor, cabled for an EtherChannel that never got finished. Shut on the core side.
  net.connect('core1', 'GigabitEthernet0/3', 'acc1', 'GigabitEthernet0/2');
  trunk(core, 'GigabitEthernet0/3', 'Spare uplink to CR-ACC1 Gi0/2 (EtherChannel, never finished)');
  core.running.interfaces['GigabitEthernet0/3'].shutdown = true;
  trunk(net.device('acc1'), 'GigabitEthernet0/2', 'Spare uplink to CR-CORE1 Gi0/3');
  // Switching hygiene the predecessor did set up: VTP transparent, the core as STP root, PortFast and BPDU guard
  // on access ports, and sticky port security on the 2nd floor (the audit team asked for it).
  for (const id of ['core1', 'acc1', 'acc2']) {
    const d = net.device(id);
    d.running.vtp = { mode: 'transparent', domain: 'CEDAR', password: null, version: 1 };
    d.running.stp = { mode: 'pvst', priorities: [], disabled: [], portfastDefault: id !== 'core1', bpduguardDefault: id !== 'core1', bpdufilterDefault: false, loopguardDefault: false };
  }
  core.running.stp!.priorities = [{ vlans: [1, ...VLANS.map((v) => v.id)], priority: 24576 }];
  for (let i = 1; i <= 10; i++) {
    net.device('acc2').running.interfaces[`FastEthernet0/${i}`].portSecurity = { enabled: true, max: 1, violation: 'shutdown', sticky: true, macs: [], stickyMacs: [] };
  }
  // A spare run between the core and the router, never configured. Useful for router-on-a-stick.
  net.connect('rtr1', 'GigabitEthernet0/2', 'core1', 'FastEthernet0/23');
  core.running.interfaces['FastEthernet0/23'].description = 'Spare to CR-RTR1 Gi0/2';
  SERVERS.forEach((s, i) => net.connect(s.id, nic(net.device(s.id)), 'core1', `FastEthernet0/${i + 1}`));
  net.connect('noc', nic(noc), 'core1', 'FastEthernet0/10');
  // The NOC PC runs a TFTP server (nothing has ever been backed up to it).
  noc.tftpd = true;
  // NSOS: everything still runs the release it shipped with; the newer images were downloaded to the NOC PC's
  // TFTP root ahead of an upgrade nobody scheduled.
  for (const id of ['rtr1', 'core1', 'acc1', 'acc2']) installImage(net.device(id));
  noc.images = Object.fromEntries(Object.values(RELEASES).flat().map((r) => [r.file, anyImage(r.file)!]));

  for (const id of ['rtr1', 'core1', 'acc1', 'acc2']) inheritedSsh(net.device(id), net.rng.int(1000, 9999));
  // The predecessor hated being logged out, and kept a clear-text break-glass account on the router.
  for (const id of ['rtr1', 'core1']) {
    const lines = net.device(id).running.lines;
    lines.vty.execTimeout = [0, 0];
    lines.con.execTimeout = [0, 0];
  }
  net.device('rtr1').running.users.backup = { privilege: 15, secret: null, password: 'Cedar2019!' };
  // Syslog to the NOC PC, SNMP for the NOC's poller, and time from the domain controller. CR-ACC2 is the
  // replacement switch a contractor installed last spring from a bare template: none of this was ever set up on it.
  const where: Record<string, string> = { rtr1: 'Server room rack 1', core1: 'Server room rack 1', acc1: '1st floor IDF closet' };
  for (const id of ['rtr1', 'core1', 'acc1']) {
    const d = net.device(id).running;
    d.logging = { hosts: [parseIp(NOC_PC_IP)!], trap: 6, console: 7, monitor: 7, buffered: { size: 16384, level: 7 } };
    d.snmp = { communities: { [SNMP_COMMUNITY]: { access: 'RO' } }, location: where[id], contact: 'Mike Delaney x4410', groups: {}, users: {} };
    d.ntp = { servers: [{ ip: parseIp('10.10.20.10')!, prefer: false }], master: null };
  }
  net.syslogCollector = parseIp(NOC_PC_IP);

  // --- DHCP and DNS on CR-DC01; staff PCs get reserved addresses, relayed by CR-CORE1 -------
  const dc = net.device('dc01');
  const staffPcs = people.map((p) => net.device(p.pcId));
  dc.dhcpServer = {
    scopes: [
      {
        network: parseIp('10.10.10.0')!,
        prefix: 24,
        start: parseIp('10.10.10.150')!,
        end: parseIp('10.10.10.199')!,
        gateway: parseIp('10.10.10.1')!,
        dns: parseIp('10.10.20.10')!,
        reservations: Object.fromEntries(staffPcs.map((pc) => [pc.hardware[nic(pc)].mac, pc.running.interfaces[nic(pc)].ip!.address])),
        leases: {},
      },
    ],
  };
  const zone: Record<string, string> = {
    'cr-dc01': '10.10.20.10',
    'cr-fs01': '10.10.20.11',
    'cr-app01': '10.10.20.12',
    ledgerworks: '10.10.20.12',
    'cr-prn1': '10.10.30.21',
    'cr-prn2': '10.10.30.22',
  };
  dc.dnsZone = Object.fromEntries(Object.entries(zone).map(([n, a]) => [`${n}.${DOMAIN}`, parseIp(a)!]));
  dc.dnsZone['www.example.com'] = parseIp('8.8.8.8')!;
  net.device('core1').running.interfaces['Vlan10'].helpers = [parseIp('10.10.20.10')!];
  net.commit({ silent: true });
  for (const pc of staffPcs) {
    pc.hostNet = { dhcp: true, lease: null, apipa: false, dnsServer: null, dnsCache: {} };
    dhcpRequest(net, pc.id);
  }
  conf.hostNet = { dhcp: true, lease: null, apipa: false, dnsServer: null, dnsCache: {} };
  dhcpRequest(net, conf.id);
  // Public DNS out on the internet, for anything pointed at 8.8.8.8.
  internet.dnsZone = Object.fromEntries(
    ['www.example.com', 'example.com', 'www.google.com', 'outlook.office365.com', 'teams.microsoft.com'].map((n) => [n, parseIp('8.8.8.8')!]),
  );
  // The NOC PC is static, pointed at the same DNS server.
  noc.hostNet = { dhcp: false, lease: null, apipa: false, dnsServer: parseIp('10.10.20.10'), dnsCache: {} };

  // --- Tutorial incident: Priya's switchport was left shut down ---------------------------
  const tutorialPort = 'FastEthernet0/7';
  net.device('acc1').running.interfaces[tutorialPort].shutdown = true;

  initLabels(net, { people } as Office);
  for (const device of net.devices.values()) device.startup = structuredClone(device.running);
  net.commit({ silent: true });

  return {
    net,
    layout,
    people,
    home: 'noc',
    hostOptions: { noc: { user: DEFAULT_ADMIN_USER, sshKey: NOC_PC_KEY } },
    tutorial: { person: people[6], pcId: TUTORIAL_PC, switchId: 'acc1', port: tutorialPort },
  };
}
