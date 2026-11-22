// Helpers shared by the routing protocols.

import type { Packet } from '../acl';
import { classfulPrefix, inSubnet, networkOf, prefixToMask, type Ipv4 } from '../ip';
import type { Network } from '../network';
import { aclPermits, l3Interfaces, routes, type L3Interface } from '../routing';
import type { Device } from '../types';

export interface RIface extends L3Interface {
  device: Device;
}

/** Devices that route and are powered up. */
export function routers(net: Network): Device[] {
  return [...net.devices.values()].filter((d) => routes(d) && net.isOnline(d));
}

export function upInterfaces(net: Network, d: Device): RIface[] {
  return l3Interfaces(net, d)
    .filter((i) => i.up)
    .map((i) => ({ ...i, device: d }));
}

/** Interface bandwidth in kbps, as IOS reports it (`bandwidth` overrides; otherwise the negotiated speed). */
export function bandwidthKbps(d: Device, iface: string, net?: Network): number {
  const cfg = d.running.interfaces[iface];
  if (cfg?.bandwidth) return cfg.bandwidth;
  const base = iface.split('.')[0];
  const speed = net && d.hardware[base] ? net.negotiatedSpeed(d.id, base) : null;
  if (speed) return speed * 1000;
  if (iface.startsWith('Loopback')) return 8_000_000;
  if (iface.startsWith('Vlan')) return 1_000_000;
  if (base.startsWith('GigabitEthernet')) return 1_000_000;
  if (base.startsWith('FastEthernet')) return 100_000;
  if (base.startsWith('Serial')) return 1544;
  return 100_000;
}

/** Interface delay in tens of microseconds (`delay` overrides). */
export function delayTens(d: Device, iface: string): number {
  const cfg = d.running.interfaces[iface];
  if (cfg?.delay) return cfg.delay;
  if (iface.startsWith('Loopback')) return 500;
  if (iface.startsWith('Vlan')) return 1;
  const base = iface.split('.')[0];
  if (base.startsWith('GigabitEthernet')) return 1;
  if (base.startsWith('FastEthernet')) return 10;
  if (base.startsWith('Serial')) return 2000;
  return 10;
}

/** IP MTU of an interface (`ip mtu` or `mtu`). */
export function ipMtu(d: Device, iface: string): number {
  const cfg = d.running.interfaces[iface];
  return cfg?.ipMtu ?? cfg?.mtu ?? 1500;
}

/** Two router interfaces that can hear each other: same broadcast domain, each in the other's subnet. */
export function onSameSegment(net: Network, a: RIface, b: RIface): boolean {
  if (a.device.id === b.device.id) return false;
  if (net.domainOf(a.device.id, a.name) !== net.domainOf(b.device.id, b.name)) return false;
  return inSubnet(a.address, b.address, b.prefix) && inSubnet(b.address, a.address, a.prefix);
}

/** Do routing protocol packets from `from` get past the ACL inbound on `to`? */
export function protocolPermitted(from: RIface, to: RIface, pkt: Omit<Packet, 'src' | 'dst'>, dst: Ipv4): boolean {
  return aclPermits(to.device, to.name, 'in', { ...pkt, src: from.address, dst } as Packet, false);
}

/** Major (classful) network of an address. */
export function major(ip: Ipv4): { network: Ipv4; prefix: number } {
  const p = classfulPrefix(ip);
  return { network: networkOf(ip, p), prefix: p };
}

export function wildcardMatch(ip: Ipv4, addr: Ipv4, wildcard: Ipv4): boolean {
  return ((ip & ~wildcard) >>> 0) === ((addr & ~wildcard) >>> 0);
}

export function maskOf(prefix: number): Ipv4 {
  return prefixToMask(prefix);
}

/** "00:12:34" or "1d02h" like IOS route ages. */
export function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d${String(h).padStart(2, '0')}h`;
  return [h, m, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Highest loopback address, else highest active interface address (how IOS picks a router ID). */
export function autoRouterId(net: Network, d: Device): Ipv4 {
  const ifs = upInterfaces(net, d);
  const loops = ifs.filter((i) => i.name.startsWith('Loopback'));
  const pool = loops.length ? loops : ifs;
  return pool.reduce((m, i) => (i.address > m ? i.address : m), 0);
}
