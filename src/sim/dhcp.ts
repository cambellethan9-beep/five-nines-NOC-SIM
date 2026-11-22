// DHCP for PCs. A PC asks for an address when its link comes up or when someone runs ipconfig /renew.
// The request is answered by a DHCP server in the same broadcast domain, or relayed by a router/L3 switch
// interface with `ip helper-address`. No answer means APIPA (169.254.x.x), and Windows keeps it until renewed.

import { inSubnet, type Ipv4 } from './ip';
import type { Network } from './network';
import { canReach, l3Interfaces, ownsAddress, routes } from './routing';
import type { DhcpLease, DhcpScope, Device } from './types';

export function nicOf(device: Device): string {
  return Object.keys(device.hardware)[0];
}

/** Windows picks a 169.254.x.y address; deterministic per MAC here. */
export function apipaAddress(mac: string): Ipv4 {
  let h = 2166136261;
  for (const c of mac) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const x = ((h >>> 0) % 254) + 1;
  const y = ((h >>> 8) % 254) + 1;
  return ((169 << 24) | (254 << 16) | (x << 8) | y) >>> 0;
}

export function isApipa(ip: Ipv4): boolean {
  return ip >>> 16 === ((169 << 8) | 254);
}

interface Offer {
  scope: DhcpScope;
  serverIp: Ipv4;
}

/** Finds a DHCP server that would answer this PC: directly on its LAN, or through a relay. */
function findServer(net: Network, pc: Device): Offer | null {
  const nic = nicOf(pc);
  const domain = net.domainOf(pc.id, nic);
  for (const device of net.devices.values()) {
    if (!net.isOnline(device)) continue;
    for (const ifc of l3Interfaces(net, device)) {
      if (!ifc.up || net.domainOf(device.id, ifc.name) !== domain || (device.id === pc.id && ifc.name === nic)) continue;
      // A DHCP server right on this LAN.
      if (device.dhcpServer) {
        const scope = device.dhcpServer.scopes.find((s) => inSubnet(ifc.address, s.network, s.prefix));
        if (scope) return { scope, serverIp: ifc.address };
      }
      // A relay: the router forwards the broadcast to its helper addresses, tagged with this interface's subnet.
      if (!routes(device)) continue;
      const helpers = device.running.interfaces[ifc.name]?.helpers ?? [];
      for (const helper of helpers) {
        const server = [...net.devices.values()].find((d) => d.dhcpServer && net.isOnline(d) && ownsAddress(net, d, helper));
        if (!server || !canReach(net, device.id, helper)) continue;
        const scope = server.dhcpServer!.scopes.find((s) => inSubnet(ifc.address, s.network, s.prefix));
        if (scope) return { scope, serverIp: helper };
      }
    }
  }
  return null;
}

function allocate(scope: DhcpScope, mac: string): Ipv4 | null {
  if (scope.reservations[mac] !== undefined) return scope.reservations[mac];
  if (scope.leases[mac] !== undefined) return scope.leases[mac];
  const taken = new Set([...Object.values(scope.reservations), ...Object.values(scope.leases)]);
  for (let ip = scope.start; ip <= scope.end; ip++) if (!taken.has(ip)) return ip;
  return null; // scope exhausted
}

/** Writes an address into the PC's NIC config (or clears it). */
function apply(net: Network, pc: Device, lease: DhcpLease | null, apipa: boolean): void {
  const nic = pc.running.interfaces[nicOf(pc)];
  const hn = pc.hostNet!;
  hn.lease = lease;
  hn.apipa = apipa;
  if (lease) {
    nic.ip = { address: lease.ip, prefix: lease.prefix };
    pc.running.defaultGateway = lease.gateway;
  } else if (apipa) {
    nic.ip = { address: apipaAddress(pc.hardware[nicOf(pc)].mac), prefix: 16 };
    pc.running.defaultGateway = null;
  } else {
    nic.ip = null;
    pc.running.defaultGateway = null;
  }
  net.commit({ silent: true });
}

export type DhcpResult = { ok: true; lease: DhcpLease } | { ok: false; reason: 'static' | 'disconnected' | 'no-adapter' | 'no-answer' };

/** DHCP discover/offer/request/ack. Falls back to APIPA if nobody answers. */
export function dhcpRequest(net: Network, pcId: string): DhcpResult {
  const pc = net.device(pcId);
  if (!pc.hostNet?.dhcp) return { ok: false, reason: 'static' };
  if (!net.nicWorking(pc)) return { ok: false, reason: 'no-adapter' };
  if (!net.isUp(pc.id, nicOf(pc))) return { ok: false, reason: 'disconnected' };
  const offer = findServer(net, pc);
  const mac = pc.hardware[nicOf(pc)].mac;
  const ip = offer ? allocate(offer.scope, mac) : null;
  if (!offer || ip === null) {
    apply(net, pc, null, true);
    return { ok: false, reason: 'no-answer' };
  }
  offer.scope.leases[mac] = ip;
  const lease: DhcpLease = { ip, prefix: offer.scope.prefix, gateway: offer.scope.gateway, dns: offer.scope.dns, server: offer.serverIp, obtainedAt: net.time };
  apply(net, pc, lease, false);
  return { ok: true, lease };
}

/** ipconfig /release */
export function dhcpRelease(net: Network, pcId: string): boolean {
  const pc = net.device(pcId);
  if (!pc.hostNet?.dhcp) return false;
  apply(net, pc, null, false);
  return true;
}

/** Puts a PC on APIPA as if its last request went unanswered (used by tickets). */
export function forceApipa(net: Network, pcId: string): void {
  const pc = net.device(pcId);
  if (pc.hostNet) apply(net, pc, null, true);
}

/** Windows requests an address every time the link comes up. Call once per tick. */
export class DhcpWatcher {
  private readonly wasUp = new Map<string, boolean>();

  /** Records current link states without sending requests (after building or loading a game). */
  baseline(net: Network): void {
    for (const d of net.devices.values()) if (d.hostNet?.dhcp) this.wasUp.set(d.id, net.isUp(d.id, nicOf(d)));
  }

  update(net: Network): void {
    for (const d of net.devices.values()) {
      if (!d.hostNet?.dhcp) continue;
      const up = net.isUp(d.id, nicOf(d));
      if (up && this.wasUp.get(d.id) === false) dhcpRequest(net, d.id);
      this.wasUp.set(d.id, up);
    }
  }
}
