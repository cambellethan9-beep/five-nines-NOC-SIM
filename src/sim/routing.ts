// Layer 3: routing tables, ARP resolution and the hop-by-hop packet walk used by ping/traceroute.
// The sim models state, not packets: a "packet" is a lookup walk across devices.

import { formatIp, inSubnet, networkOf, type Ipv4 } from './ip';
import type { Network } from './network';
import type { Device } from './types';

export type RouteCode = 'C' | 'L' | 'S';

export interface Route {
  code: RouteCode;
  network: Ipv4;
  prefix: number;
  distance: number;
  metric: number;
  nextHop: Ipv4 | null;
  iface: string | null;
  isDefault: boolean;
}

export interface L3Interface {
  name: string;
  address: Ipv4;
  prefix: number;
  up: boolean;
}

export function routes(device: Device): boolean {
  return device.kind === 'router' || (device.kind === 'l3switch' && device.running.ipRouting);
}

export function l3Interfaces(net: Network, device: Device): L3Interface[] {
  const result: L3Interface[] = [];
  for (const ifc of Object.values(device.running.interfaces)) {
    if (!ifc.ip) continue;
    // On a switch, physical switchports cannot hold an IP; only SVIs and routed ports can.
    if (ifc.switchport) continue;
    result.push({ name: ifc.name, address: ifc.ip.address, prefix: ifc.ip.prefix, up: net.isUp(device.id, ifc.name) });
  }
  return result;
}

/** Builds the routing table as `show ip route` would display it. */
export function routingTable(net: Network, device: Device): Route[] {
  const table: Route[] = [];
  const up = l3Interfaces(net, device).filter((i) => i.up);
  for (const i of up) {
    table.push({
      code: 'C',
      network: networkOf(i.address, i.prefix),
      prefix: i.prefix,
      distance: 0,
      metric: 0,
      nextHop: null,
      iface: i.name,
      isDefault: false,
    });
    if (i.prefix < 32) {
      table.push({
        code: 'L',
        network: i.address,
        prefix: 32,
        distance: 0,
        metric: 0,
        nextHop: null,
        iface: i.name,
        isDefault: false,
      });
    }
  }
  if (!routes(device)) return table;

  // Static routes install only when their next hop resolves (recursively) or their exit interface is up.
  const connected = [...table];
  const statics = device.running.staticRoutes;
  const installed: Route[] = [];
  let progress = true;
  const pending = [...statics];
  while (progress) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const s = pending[i];
      let ok = false;
      if (s.exitIf) ok = net.isUp(device.id, s.exitIf);
      else if (s.nextHop !== null) ok = longestMatch([...connected, ...installed], s.nextHop) !== null;
      if (ok) {
        installed.push({
          code: 'S',
          network: s.network,
          prefix: s.prefix,
          distance: s.distance,
          metric: 0,
          nextHop: s.nextHop,
          iface: s.exitIf,
          isDefault: s.prefix === 0,
        });
        pending.splice(i, 1);
        progress = true;
      }
    }
  }
  // Keep only the lowest administrative distance per prefix (a floating static stays out until needed).
  for (const r of installed) {
    const better = table.find((t) => t.network === r.network && t.prefix === r.prefix && t.distance < r.distance);
    if (better) continue;
    for (let i = table.length - 1; i >= 0; i--) {
      const t = table[i];
      if (t.network === r.network && t.prefix === r.prefix && t.distance > r.distance) table.splice(i, 1);
    }
    table.push(r);
  }
  return table;
}

function longestMatch(table: Route[], dest: Ipv4): Route | null {
  let best: Route | null = null;
  for (const r of table) {
    if (r.code === 'L' && r.network !== dest) continue;
    if (!inSubnet(dest, r.network, r.prefix)) continue;
    if (!best || r.prefix > best.prefix || (r.prefix === best.prefix && r.distance < best.distance)) best = r;
  }
  return best;
}

interface Decision {
  egress: string;
  nextHop: Ipv4;
  /** True when the route only names an exit interface, so proxy ARP may answer. */
  viaInterfaceOnly: boolean;
}

/** Where does `device` send a packet for `dest`? */
function forwardingDecision(net: Network, device: Device, dest: Ipv4): Decision | null {
  if (routes(device)) {
    const table = routingTable(net, device);
    let route = longestMatch(table, dest);
    let depth = 0;
    let nextHop = dest;
    // Resolve recursive static routes down to a connected interface.
    while (route && route.code === 'S' && depth < 8) {
      if (route.iface) return { egress: route.iface, nextHop: route.nextHop ?? nextHop, viaInterfaceOnly: !route.nextHop };
      nextHop = route.nextHop!;
      route = longestMatch(table, nextHop);
      depth++;
    }
    if (!route || !route.iface) return null;
    return { egress: route.iface, nextHop, viaInterfaceOnly: false };
  }
  // Hosts and L2 switches: on-link or default gateway.
  const ifs = l3Interfaces(net, device).filter((i) => i.up);
  const onLink = ifs.find((i) => inSubnet(dest, i.address, i.prefix));
  if (onLink) return { egress: onLink.name, nextHop: dest, viaInterfaceOnly: false };
  const gw = device.running.defaultGateway;
  if (gw === null) return null;
  const gwIf = ifs.find((i) => inSubnet(gw, i.address, i.prefix));
  if (!gwIf) return null;
  return { egress: gwIf.name, nextHop: gw, viaInterfaceOnly: false };
}

export interface Endpoint {
  device: string;
  iface: string;
}

/** Finds who answers an ARP request for `ip` in the broadcast domain of device/iface. */
function arpResolve(net: Network, deviceId: string, iface: string, ip: Ipv4, allowProxy: boolean): Endpoint | null {
  const domain = net.domainOf(deviceId, iface);
  let proxy: Endpoint | null = null;
  for (const other of net.devices.values()) {
    if (!net.isOnline(other)) continue;
    for (const ifc of l3Interfaces(net, other)) {
      if (!ifc.up || (other.id === deviceId && ifc.name === iface)) continue;
      if (net.domainOf(other.id, ifc.name) !== domain) continue;
      if (ifc.address === ip) return { device: other.id, iface: ifc.name };
      if (allowProxy && !proxy && routes(other)) {
        // Proxy ARP: a router answers for an address it can route somewhere other than back out this port.
        const decision = forwardingDecision(net, other, ip);
        if (decision && decision.egress !== ifc.name) proxy = { device: other.id, iface: ifc.name };
      }
    }
  }
  return proxy;
}

export function macOf(device: Device, iface: string): string {
  const physical = iface.split('.')[0];
  return device.hardware[physical]?.mac ?? device.baseMac;
}

export function ownsAddress(net: Network, device: Device, ip: Ipv4): L3Interface | null {
  return l3Interfaces(net, device).find((i) => i.up && i.address === ip) ?? null;
}

export interface Hop {
  device: string;
  ingress: string;
  ingressIp: Ipv4 | null;
}

export type WalkFailure = 'no-route' | 'arp' | 'ttl';

export interface WalkResult {
  delivered: boolean;
  hops: Hop[];
  /** Device where the packet died, if not delivered. */
  failedAt?: string;
  failure?: WalkFailure;
  /** True if any device on the path had to ARP (first ping packet is lost). */
  arpMiss: boolean;
}

/**
 * Walks a packet from `fromDevice` toward `dest`, hop by hop.
 * Updates ARP caches unless `learn` is false (used for silent checks the player doesn't see).
 */
export function walk(net: Network, fromDevice: string, dest: Ipv4, maxHops = 30, learn = true): WalkResult {
  const hops: Hop[] = [];
  let current = net.device(fromDevice);
  let arpMiss = false;
  for (let ttl = 0; ttl < maxHops; ttl++) {
    if (ownsAddress(net, current, dest)) return { delivered: true, hops, arpMiss };
    const decision = forwardingDecision(net, current, dest);
    if (!decision) return { delivered: false, hops, failedAt: current.id, failure: 'no-route', arpMiss };
    const target = arpResolve(net, current.id, decision.egress, decision.nextHop, decision.viaInterfaceOnly);
    if (!target) return { delivered: false, hops, failedAt: current.id, failure: 'arp', arpMiss };

    const cached = current.arp.get(decision.nextHop);
    if (learn && (!cached || cached.iface !== decision.egress)) {
      arpMiss = true;
      const next = net.device(target.device);
      current.arp.set(decision.nextHop, { mac: macOf(next, target.iface), iface: decision.egress, learnedAt: net.time });
      // The responder learns the requester too.
      const srcIp = l3Interfaces(net, current).find((i) => i.name === decision.egress)?.address;
      if (srcIp !== undefined) {
        next.arp.set(srcIp, { mac: macOf(current, decision.egress), iface: target.iface, learnedAt: net.time });
      }
    }
    const next = net.device(target.device);
    const ingressIp = next.running.interfaces[target.iface]?.ip?.address ?? null;
    hops.push({ device: next.id, ingress: target.iface, ingressIp });
    current = next;
  }
  return { delivered: false, hops, failedAt: current.id, failure: 'ttl', arpMiss };
}

/**
 * Can `fromDevice` exchange traffic with `dest` (both directions)? Has no side effects.
 * This is what ticket verification uses: it checks the outcome, not which commands fixed it.
 */
export function canReach(net: Network, fromDevice: string, dest: Ipv4): boolean {
  const srcIp = sourceAddressFor(net, net.device(fromDevice), dest);
  if (srcIp === null) return false;
  const forward = walk(net, fromDevice, dest, 30, false);
  if (!forward.delivered) return false;
  const destDevice = forward.hops.length ? forward.hops[forward.hops.length - 1].device : fromDevice;
  return walk(net, destDevice, srcIp, 30, false).delivered;
}

/** The source address a device uses when it originates traffic toward `dest`. */
export function sourceAddressFor(net: Network, device: Device, dest: Ipv4): Ipv4 | null {
  const decision = forwardingDecision(net, device, dest);
  if (!decision) return null;
  return l3Interfaces(net, device).find((i) => i.name === decision.egress)?.address ?? null;
}

export interface PingResult {
  /** IOS-style characters for each echo, e.g. "!!!!!", ".!!!!", "U.U.U", "....." */
  marks: string;
  successes: number;
  rttMs: number[];
  /** Routers crossed on the way (for TTL in host ping output). */
  hops: number;
  /** Device that answered, if the echo was delivered. */
  destDevice: string | null;
}

export function ping(net: Network, fromDevice: string, dest: Ipv4, count = 5): PingResult {
  const source = net.device(fromDevice);
  const srcIp = sourceAddressFor(net, source, dest);
  const forward = walk(net, fromDevice, dest);
  let marks: string;
  let destDevice: string | null = null;
  if (!forward.delivered) {
    // A router along the path that has no route answers with ICMP unreachable (rate-limited: U.U.U).
    const unreachable =
      forward.failure === 'no-route' &&
      forward.failedAt !== fromDevice &&
      srcIp !== null &&
      walk(net, forward.failedAt!, srcIp).delivered;
    marks = (unreachable ? 'U.' : '..').repeat(count).slice(0, count);
  } else {
    destDevice = forward.hops.length ? forward.hops[forward.hops.length - 1].device : fromDevice;
    const back = srcIp === null ? null : walk(net, destDevice, srcIp);
    if (!back || !back.delivered) marks = '.'.repeat(count);
    else if (forward.arpMiss || back.arpMiss) marks = '.' + '!'.repeat(count - 1);
    else marks = '!'.repeat(count);
  }
  const successes = [...marks].filter((c) => c === '!').length;
  const hops = forward.hops.length || 1;
  const rttMs = [...marks].filter((c) => c === '!').map(() => hops + net.rng.int(0, hops * 2));
  return { marks, successes, rttMs, hops: Math.max(0, forward.hops.length - 1), destDevice };
}

export interface TraceHop {
  ttl: number;
  /** null when no reply came back ("* * *"). */
  address: Ipv4 | null;
  unreachable: boolean;
  rttMs: number[];
}

export function traceroute(net: Network, fromDevice: string, dest: Ipv4, maxTtl = 30): TraceHop[] {
  const source = net.device(fromDevice);
  const srcIp = sourceAddressFor(net, source, dest);
  const forward = walk(net, fromDevice, dest, maxTtl);
  const result: TraceHop[] = [];
  const rtt = (n: number) => [0, 1, 2].map(() => n + net.rng.int(0, n + 1));
  forward.hops.forEach((hop, i) => {
    const isLast = forward.delivered && i === forward.hops.length - 1;
    const replyFrom = isLast ? dest : hop.ingressIp;
    const canReply = srcIp !== null && replyFrom !== null && walk(net, hop.device, srcIp).delivered;
    result.push({ ttl: i + 1, address: canReply ? replyFrom : null, unreachable: false, rttMs: rtt(i + 1) });
  });
  if (forward.delivered) return result;
  if (forward.failure === 'no-route' && forward.failedAt !== fromDevice && srcIp !== null) {
    const failed = net.device(forward.failedAt!);
    const lastHop = forward.hops[forward.hops.length - 1];
    if (walk(net, failed.id, srcIp).delivered) {
      result.push({ ttl: result.length + 1, address: lastHop.ingressIp, unreachable: true, rttMs: rtt(result.length + 1) });
      return result;
    }
  }
  for (let ttl = result.length + 1; ttl <= maxTtl; ttl++) result.push({ ttl, address: null, unreachable: false, rttMs: [] });
  return result;
}

export function describeIp(ip: Ipv4 | null): string {
  return ip === null ? 'unassigned' : formatIp(ip);
}

