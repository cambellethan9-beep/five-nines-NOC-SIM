// The Phase 0 test network: a small HQ with router-on-a-stick and a remote server site.
// It doubles as the tutorial setup: SW1 Fa0/1 (PC1's port) has been left shut down.
//
//   PC1 (VLAN 10) --Fa0/1--+
//                          SW1 --Gi0/1 (trunk)-- Gi0/0 R1 Gi0/1 --- Gi0/1 R2 Gi0/0 --- Fa0/24 SW2 Fa0/1 --- SRV1
//   PC2 (VLAN 20) --Fa0/2--+
//   NOC-PC (VLAN 10, 10.10.10.50) --Fa0/3-- SW1   (SSH to R1 10.10.10.1, R2 10.0.12.2, SW1 10.10.10.2, SW2 10.20.1.2)

import { createDevice, DEFAULT_ADMIN_USER, defaultInterfaceConfig } from '../sim/devices';
import type { HostOptions } from '../sim/host';
import { parseIp, maskToPrefix } from '../sim/ip';
import { Network } from '../sim/network';
import type { Device, StaticRoute } from '../sim/types';

function ip(text: string) {
  const [addr, mask] = text.split(' ');
  return { address: parseIp(addr)!, prefix: maskToPrefix(parseIp(mask)!)! };
}

function route(net: string, mask: string, nextHop: string): StaticRoute {
  return { network: parseIp(net)!, prefix: maskToPrefix(parseIp(mask)!)!, nextHop: parseIp(nextHop), exitIf: null, distance: 1 };
}

function subif(device: Device, name: string, vlan: number, addr: string, description: string): void {
  const ifc = defaultInterfaceConfig(name, device.kind, false);
  ifc.encapsulation = { vlan, native: false };
  ifc.ip = ip(addr);
  ifc.description = description;
  device.running.interfaces[name] = ifc;
}

/** The NOC PC's SSH key identity (as it appears in `ip ssh pubkey-chain`). */
export const NOC_PC_KEY = 'nocadmin@NOC-PC';

/** Logins for each workstation's command prompt. */
export const HOST_OPTIONS: Record<string, HostOptions> = {
  noc: { user: DEFAULT_ADMIN_USER, sshKey: NOC_PC_KEY },
};

function enableInheritedSsh(device: Device, keySerial: number): void {
  const cfg = device.running;
  cfg.domainName = 'netsmart.local';
  cfg.crypto = { bits: 2048, serial: keySerial };
  cfg.ssh.version = 2;
  // The predecessor's password is long gone; key-based login from the NOC PC is what works.
  cfg.users[DEFAULT_ADMIN_USER] = { privilege: 15, secret: 'Pr3decess0r!Left', password: null };
  cfg.authorizedKeys = [{ user: DEFAULT_ADMIN_USER, key: NOC_PC_KEY }];
  cfg.lines.vty.login = 'local';
  cfg.lines.vty.transport = { ssh: true, telnet: false };
}

export function buildDemoNetwork(seed: number | string = 'demo'): Network {
  const net = new Network(seed);

  const r1 = net.addDevice(createDevice('r1', 'NS-R4300', 'R1'));
  const r2 = net.addDevice(createDevice('r2', 'NS-R4300', 'R2'));
  const sw1 = net.addDevice(createDevice('sw1', 'NS-S2900', 'SW1'));
  const sw2 = net.addDevice(createDevice('sw2', 'NS-S2900', 'SW2'));
  const pc1 = net.addDevice(createDevice('pc1', 'NS-PC', 'PC1'));
  const pc2 = net.addDevice(createDevice('pc2', 'NS-PC', 'PC2'));
  const srv1 = net.addDevice(createDevice('srv1', 'NS-SRV', 'SRV1'));

  // R1: router-on-a-stick for VLANs 10 and 20, WAN link to R2.
  const r1g0 = r1.running.interfaces['GigabitEthernet0/0'];
  r1g0.shutdown = false;
  r1g0.description = 'Trunk to SW1';
  subif(r1, 'GigabitEthernet0/0.10', 10, '10.10.10.1 255.255.255.0', 'SALES gateway');
  subif(r1, 'GigabitEthernet0/0.20', 20, '10.10.20.1 255.255.255.0', 'ENG gateway');
  const r1g1 = r1.running.interfaces['GigabitEthernet0/1'];
  r1g1.shutdown = false;
  r1g1.description = 'WAN to R2';
  r1g1.ip = ip('10.0.12.1 255.255.255.252');
  r1.running.staticRoutes.push(route('10.20.0.0', '255.255.0.0', '10.0.12.2'));

  // R2: WAN link and the server LAN.
  const r2g1 = r2.running.interfaces['GigabitEthernet0/1'];
  r2g1.shutdown = false;
  r2g1.description = 'WAN to R1';
  r2g1.ip = ip('10.0.12.2 255.255.255.252');
  const r2g0 = r2.running.interfaces['GigabitEthernet0/0'];
  r2g0.shutdown = false;
  r2g0.description = 'Server LAN';
  r2g0.ip = ip('10.20.1.1 255.255.255.0');
  r2.running.staticRoutes.push(route('0.0.0.0', '0.0.0.0', '10.0.12.1'));

  // SW1: access switch with VLANs 10/20 and a trunk to R1.
  sw1.vlans[10] = { name: 'SALES' };
  sw1.vlans[20] = { name: 'ENG' };
  const sw1Ifs = sw1.running.interfaces;
  sw1Ifs['GigabitEthernet0/1'].switchport!.mode = 'trunk';
  sw1Ifs['GigabitEthernet0/1'].description = 'Uplink to R1';
  sw1Ifs['FastEthernet0/1'].switchport!.mode = 'access';
  sw1Ifs['FastEthernet0/1'].switchport!.accessVlan = 10;
  sw1Ifs['FastEthernet0/1'].description = 'PC1 - Sales';
  sw1Ifs['FastEthernet0/2'].switchport!.mode = 'access';
  sw1Ifs['FastEthernet0/2'].switchport!.accessVlan = 20;
  sw1Ifs['FastEthernet0/2'].description = 'PC2 - Eng';
  const sw1Vlan10 = defaultInterfaceConfig('Vlan10', 'switch', false);
  sw1Vlan10.ip = ip('10.10.10.2 255.255.255.0');
  sw1Vlan10.description = 'Management';
  sw1Ifs['Vlan10'] = sw1Vlan10;
  sw1.running.defaultGateway = parseIp('10.10.10.1');

  // SW2: flat access switch for the server.
  sw2.running.interfaces['FastEthernet0/24'].description = 'Uplink to R2';
  sw2.running.interfaces['FastEthernet0/1'].description = 'SRV1';

  // Hosts.
  pc1.running.interfaces['FastEthernet0'].ip = ip('10.10.10.11 255.255.255.0');
  pc1.running.defaultGateway = parseIp('10.10.10.1');
  pc2.running.interfaces['FastEthernet0'].ip = ip('10.10.20.12 255.255.255.0');
  pc2.running.defaultGateway = parseIp('10.10.20.1');
  srv1.running.interfaces['GigabitEthernet0'].ip = ip('10.20.1.10 255.255.255.0');
  srv1.running.defaultGateway = parseIp('10.20.1.1');

  // The NOC's admin workstation, on the Sales/management VLAN.
  const noc = net.addDevice(createDevice('noc', 'NS-PC', 'NOC-PC'));
  noc.running.interfaces['FastEthernet0'].ip = ip('10.10.10.50 255.255.255.0');
  noc.running.defaultGateway = parseIp('10.10.10.1');
  sw1Ifs['FastEthernet0/3'].switchport!.mode = 'access';
  sw1Ifs['FastEthernet0/3'].switchport!.accessVlan = 10;
  sw1Ifs['FastEthernet0/3'].description = 'NOC-PC';

  // SW2 management address.
  const sw2Vlan1 = sw2.running.interfaces['Vlan1'];
  sw2Vlan1.shutdown = false;
  sw2Vlan1.ip = ip('10.20.1.2 255.255.255.0');
  sw2.running.defaultGateway = parseIp('10.20.1.1');

  // The predecessor set up SSH everywhere and trusted the NOC PC's key, so `ssh nocadmin@<ip>` just works.
  for (const device of [r1, r2, sw1, sw2]) enableInheritedSsh(device, net.rng.int(1000, 9999));

  // Cabling.
  net.connect('noc', 'FastEthernet0', 'sw1', 'FastEthernet0/3');
  net.connect('pc1', 'FastEthernet0', 'sw1', 'FastEthernet0/1');
  net.connect('pc2', 'FastEthernet0', 'sw1', 'FastEthernet0/2');
  net.connect('sw1', 'GigabitEthernet0/1', 'r1', 'GigabitEthernet0/0');
  net.connect('r1', 'GigabitEthernet0/1', 'r2', 'GigabitEthernet0/1');
  net.connect('r2', 'GigabitEthernet0/0', 'sw2', 'FastEthernet0/24');
  net.connect('sw2', 'FastEthernet0/1', 'srv1', 'GigabitEthernet0');

  // The tutorial incident: PC1's switchport was left administratively down.
  sw1Ifs['FastEthernet0/1'].shutdown = true;

  // The predecessor saved this config, so it survives a reload.
  for (const device of net.devices.values()) device.startup = structuredClone(device.running);
  net.commit({ silent: true });
  return net;
}
