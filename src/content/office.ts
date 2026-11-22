// Season 1: Cedar Ridge Accounting — a 20-person office in one building, two floors.
//
//   INTERNET (8.8.8.8) -- ISP-RTR (not ours) -- CR-RTR1 -- CR-CORE1 (L3 switch, inter-VLAN routing)
//                                                            |-- CR-DC01 / CR-FS01 / CR-APP01  (VLAN 20)
//                                                            |-- NOC-PC                        (VLAN 99)
//                                                            |-- CR-ACC1 (1st floor) -- WS01-WS10, CR-PRN1
//                                                            '-- CR-ACC2 (2nd floor) -- WS11-WS20, CR-PRN2
//
// VLAN 10 STAFF 10.10.10.0/24 | VLAN 20 SERVERS 10.10.20.0/24 | VLAN 30 PRINTERS 10.10.30.0/24 | VLAN 99 MGMT 10.10.99.0/24

import { createDevice, DEFAULT_ADMIN_USER, defaultInterfaceConfig } from '../sim/devices';
import type { HostOptions } from '../sim/host';
import { maskToPrefix, parseIp } from '../sim/ip';
import { Network } from '../sim/network';
import type { Device, StaticRoute } from '../sim/types';

export const COMPANY = 'Cedar Ridge Accounting';
export const NOC_PC_KEY = 'nocadmin@NOC-PC';

export const VLANS = [
  { id: 10, name: 'STAFF', subnet: '10.10.10.0/24', gateway: '10.10.10.1', purpose: 'Staff workstations' },
  { id: 20, name: 'SERVERS', subnet: '10.10.20.0/24', gateway: '10.10.20.1', purpose: 'Servers' },
  { id: 30, name: 'PRINTERS', subnet: '10.10.30.0/24', gateway: '10.10.30.1', purpose: 'Printers' },
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
  { id: 'dc01', hostname: 'CR-DC01', ip: '10.10.20.10', role: 'Domain controller, DNS' },
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

export const ISP = { name: 'Brightline Fiber', circuit: 'BLF-88213-CR', wanIp: '203.0.113.2/30', gateway: '203.0.113.1', support: '1-800-555-0142' };

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
  // Stand-in for NAT: the ISP routes our private space back to us.
  isp.running.staticRoutes.push(route('10.0.0.0', '255.0.0.0', '203.0.113.2'));
  isp.running.lines.vty.transport = { ssh: false, telnet: false };
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
  rtr.running.staticRoutes.push(route('0.0.0.0', '0.0.0.0', '203.0.113.1'), route('10.10.0.0', '255.255.0.0', '10.0.0.2'));
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
  svi(core, 99, '10.10.99.1 255.255.255.0', 'MGMT gateway');
  core.running.staticRoutes.push(route('0.0.0.0', '0.0.0.0', '10.0.0.1'));
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

  // --- Cabling in the server room ------------------------------------------------------
  net.connect('internet', nic(internet), 'isp', 'GigabitEthernet0/1');
  net.connect('isp', 'GigabitEthernet0/0', 'rtr1', 'GigabitEthernet0/1');
  net.connect('rtr1', 'GigabitEthernet0/0', 'core1', 'FastEthernet0/24');
  // A spare run between the core and the router, never configured. Useful for router-on-a-stick.
  net.connect('rtr1', 'GigabitEthernet0/2', 'core1', 'FastEthernet0/23');
  core.running.interfaces['FastEthernet0/23'].description = 'Spare to CR-RTR1 Gi0/2';
  SERVERS.forEach((s, i) => net.connect(s.id, nic(net.device(s.id)), 'core1', `FastEthernet0/${i + 1}`));
  net.connect('noc', nic(noc), 'core1', 'FastEthernet0/10');

  for (const id of ['rtr1', 'core1', 'acc1', 'acc2']) inheritedSsh(net.device(id), net.rng.int(1000, 9999));

  // --- Tutorial incident: Priya's switchport was left shut down ---------------------------
  const tutorialPort = 'FastEthernet0/7';
  net.device('acc1').running.interfaces[tutorialPort].shutdown = true;

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
