// Layer 3: routing tables, ARP resolution and the hop-by-hop packet walk used by ping/traceroute.
// The sim models state, not packets: a "packet" is a lookup walk across devices.

import { evaluate, type Packet } from './acl';
import { natInbound, natOutbound, type Translation } from './nat';
import { dynamicRoutes } from './control';
import { formatIp, inSubnet, networkOf, type Ipv4 } from './ip';
import type { Network } from './network';
import type { Device } from './types';

export type RouteCode = 'C' | 'L' | 'S' | 'O' | 'D' | 'R' | 'B';

export interface Route {
  code: RouteCode;
  network: Ipv4;
  prefix: number;
  distance: number;
  metric: number;
  nextHop: Ipv4 | null;
  iface: string | null;
  isDefault: boolean;
  /** OSPF IA/E1/E2, EIGRP EX. */
  sub?: 'IA' | 'E1' | 'E2' | 'EX';
  /** "ospf 1", "eigrp 100", "rip", "bgp 65010". */
  source?: string;
  /** Router ID of the originator (OSPF/EIGRP). */
  originator?: Ipv4;
  /** Sim time the route was first installed. */
  since?: number;
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

/** Connected and local routes. */
function connectedRoutes(net: Network, device: Device): Route[] {
  const table: Route[] = [];
  for (const i of l3Interfaces(net, device).filter((x) => x.up)) {
    table.push({ code: 'C', network: networkOf(i.address, i.prefix), prefix: i.prefix, distance: 0, metric: 0, nextHop: null, iface: i.name, isDefault: false });
    if (i.prefix < 32) table.push({ code: 'L', network: i.address, prefix: 32, distance: 0, metric: 0, nextHop: null, iface: i.name, isDefault: false });
  }
  return table;
}

/** Static routes that resolve (recursively, through `known`) or whose exit interface is up. */
function installStatics(net: Network, device: Device, known: Route[]): Route[] {
  const installed: Route[] = [];
  const pending = [...device.running.staticRoutes];
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const s = pending[i];
      let ok = false;
      if (s.exitIf) ok = net.isUp(device.id, s.exitIf);
      else if (s.nextHop !== null) ok = longestMatch([...known, ...installed], s.nextHop) !== null;
      if (ok) {
        installed.push({ code: 'S', network: s.network, prefix: s.prefix, distance: s.distance, metric: 0, nextHop: s.nextHop, iface: s.exitIf, isDefault: s.prefix === 0 });
        pending.splice(i, 1);
        progress = true;
      }
    }
  }
  return installed;
}

/**
 * Picks, per prefix, the routes with the lowest administrative distance (equal-cost ones are all kept).
 * Connected and local routes always stay.
 */
function selectByDistance(routesIn: Route[]): Route[] {
  const out: Route[] = [];
  const best = new Map<string, Route[]>();
  for (const r of routesIn) {
    if (r.code === 'C' || r.code === 'L') {
      out.push(r);
      continue;
    }
    const k = `${r.network}/${r.prefix}`;
    const cur = best.get(k);
    if (!cur || r.distance < cur[0].distance) best.set(k, [r]);
    else if (r.distance === cur[0].distance && r.code === cur[0].code) cur.push(r);
  }
  const connectedKeys = new Set(out.map((r) => `${r.network}/${r.prefix}`));
  for (const [k, list] of best) if (!connectedKeys.has(k)) out.push(...list);
  return out;
}

/** Connected + static only (what the routing protocols start from). */
export function baseTable(net: Network, device: Device): Route[] {
  const connected = connectedRoutes(net, device);
  if (!routes(device)) return connected;
  return selectByDistance([...connected, ...installStatics(net, device, connected)]);
}

/** The full table given a device's dynamic routes: connected, dynamic, and statics resolved through both. */
export function mergeTables(net: Network, device: Device, dynamic: Route[]): Route[] {
  const connected = connectedRoutes(net, device);
  if (!routes(device)) return connected;
  const statics = installStatics(net, device, [...connected, ...dynamic]);
  return selectByDistance([...connected, ...dynamic, ...statics]);
}

/** Builds the routing table as `show ip route` would display it. */
export function routingTable(net: Network, device: Device): Route[] {
  if (!routes(device)) return connectedRoutes(net, device);
  return mergeTables(net, device, dynamicRoutes(net, device.id));
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
    // Follow the route's next hop; recursive routes (statics, iBGP) resolve down to an interface.
    while (route && route.code !== 'C' && route.code !== 'L' && depth < 8) {
      if (route.iface) return { egress: route.iface, nextHop: route.nextHop ?? nextHop, viaInterfaceOnly: route.code === 'S' && !route.nextHop };
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
  // A broadcast storm drowns everything in the domain: nothing gets an ARP reply.
  if (net.isStorming(domain)) return null;
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
  /** Source address of the packet as it arrived here (after any NAT on the way). */
  src?: Ipv4;
}

export type WalkFailure = 'no-route' | 'arp' | 'ttl' | 'acl' | 'nat';

/** What kind of traffic a walk carries, so ACLs can match it. Addresses are filled in by the walk. */
export type PacketSpec = Omit<Packet, 'src' | 'dst'>;

/** An application flow: protocol and destination port. Replies are derived from it. */
export interface Flow {
  proto: 'icmp' | 'tcp' | 'udp' | 'ospf' | 'eigrp';
  port?: number;
}

/** Ephemeral source port clients use (any value in the dynamic range behaves the same for ACLs). */
export const EPHEMERAL_PORT = 51034;

export function forwardPacket(flow: Flow): PacketSpec {
  if (flow.proto === 'icmp') return { proto: 'icmp', icmpType: 'echo' };
  if (flow.proto === 'tcp' || flow.proto === 'udp') return { proto: flow.proto, srcPort: EPHEMERAL_PORT, dstPort: flow.port };
  return { proto: flow.proto };
}

export function replyPacket(flow: Flow): PacketSpec {
  if (flow.proto === 'icmp') return { proto: 'icmp', icmpType: 'echo-reply' };
  if (flow.proto === 'tcp') return { proto: 'tcp', srcPort: flow.port, dstPort: EPHEMERAL_PORT, established: true };
  if (flow.proto === 'udp') return { proto: 'udp', srcPort: flow.port, dstPort: EPHEMERAL_PORT };
  return { proto: flow.proto };
}

export const PING: Flow = { proto: 'icmp' };

export interface WalkOptions {
  packet?: PacketSpec;
  /** Source address of the packet (defaults to the address the origin would use). */
  src?: Ipv4;
  /** Count ACL hits and record NAT translations (real traffic). */
  count?: boolean;
  /** Translations made by the request this packet answers, so NAT can send the reply home. */
  hints?: Translation[];
}

/** Applies the ACL bound to an interface in one direction. Undefined or empty ACLs permit everything. */
export function aclPermits(device: Device, iface: string, dir: 'in' | 'out', pkt: Packet, count: boolean): boolean {
  const name = device.running.interfaces[iface]?.accessGroup?.[dir];
  if (!name) return true;
  const acl = device.running.acls?.[name];
  if (!acl || !acl.entries.some((e) => e.remark === undefined)) return true;
  const r = evaluate(acl, pkt);
  if (count && r.seq !== null) {
    const hits = (device.aclHits ??= {});
    const key = `${name}:${r.seq}`;
    hits[key] = (hits[key] ?? 0) + 1;
  }
  return r.permit;
}

export interface WalkResult {
  delivered: boolean;
  hops: Hop[];
  /** Device where the packet died, if not delivered. */
  failedAt?: string;
  failure?: WalkFailure;
  /** True if any device on the path had to ARP (first ping packet is lost). */
  arpMiss: boolean;
  /** For 'acl' failures: the interface whose ACL dropped the packet. */
  aclIface?: string;
  /** NAT translations applied on the way. */
  translations: Translation[];
  /** The packet as it was at the end (translated addresses and ports). */
  pkt?: Packet;
}

/**
 * Walks a packet from `fromDevice` toward `dest`, hop by hop.
 * Updates ARP caches unless `learn` is false (used for silent checks the player doesn't see).
 */
export function walk(net: Network, fromDevice: string, dest: Ipv4, maxHops = 30, learn = true, opts: WalkOptions = {}): WalkResult {
  const hops: Hop[] = [];
  let current = net.device(fromDevice);
  let arpMiss = false;
  const spec = opts.packet ?? forwardPacket(PING);
  const src = opts.src ?? sourceAddressFor(net, current, dest);
  const pkt: Packet | undefined = src === null ? undefined : { ...spec, src, dst: dest };
  const count = opts.count ?? learn;
  const translations: Translation[] = [];
  let dst = dest;
  const end = (r: Omit<WalkResult, 'translations' | 'pkt' | 'hops' | 'arpMiss'>): WalkResult => ({ ...r, hops, arpMiss, translations, pkt });
  for (let ttl = 0; ttl < maxHops; ttl++) {
    if (ownsAddress(net, current, dst)) return end({ delivered: true });
    const decision = forwardingDecision(net, current, dst);
    if (!decision) return end({ delivered: false, failedAt: current.id, failure: 'no-route' });
    if (pkt && ttl > 0) {
      // IOS order inside -> outside: routing, then NAT, then the outbound ACL (which sees the translated source).
      const t = natOutbound(net, current, hops[hops.length - 1]?.ingress, decision.egress, pkt, count);
      if (t === 'drop') return end({ delivered: false, failedAt: current.id, failure: 'nat' });
      if (t) translations.push(t);
      // Outbound ACLs filter transit traffic only; IOS doesn't apply them to packets the router originates.
      if (!aclPermits(current, decision.egress, 'out', pkt, count)) {
        return end({ delivered: false, failedAt: current.id, failure: 'acl', aclIface: decision.egress });
      }
    }
    const target = arpResolve(net, current.id, decision.egress, decision.nextHop, decision.viaInterfaceOnly);
    if (!target) return end({ delivered: false, failedAt: current.id, failure: 'arp' });

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
    hops.push({ device: next.id, ingress: target.iface, ingressIp, src: pkt?.src });
    if (pkt && !aclPermits(next, target.iface, 'in', pkt, count)) {
      return end({ delivered: false, failedAt: next.id, failure: 'acl', aclIface: target.iface });
    }
    // Outside -> inside: the inbound ACL sees the global address, then NAT un-translates it.
    if (pkt && natInbound(next, target.iface, pkt, opts.hints ?? [])) dst = pkt.dst;
    current = next;
  }
  return end({ delivered: false, failedAt: current.id, failure: 'ttl' });
}

/**
 * Does the device that received a flow have something listening? Hosts run the services the game models; network
 * gear only answers ICMP, its management ports and routing protocols (anything else gets a TCP reset).
 */
function listens(device: Device, flow: Flow): boolean {
  if (flow.proto !== 'tcp' && flow.proto !== 'udp') return true;
  if (device.kind === 'pc' || device.kind === 'server' || device.kind === 'printer') return true;
  const tcp = [22, 23, 179];
  const udp = [67, 123, 161, 162, 514, 520];
  return (flow.proto === 'tcp' ? tcp : udp).includes(flow.port ?? -1);
}

/** Where a reply to this walk's packet must go, and which translations it can use to get there. */
function replyTarget(w: WalkResult, fallback: Ipv4): { to: Ipv4; from?: Ipv4; hints: Translation[]; dstPort?: number } {
  return { to: w.pkt?.src ?? fallback, from: w.pkt?.dst, hints: w.translations, dstPort: w.pkt?.srcPort };
}

/**
 * Can `fromDevice` exchange traffic with `dest` (both directions)? Has no side effects.
 * This is what ticket verification uses: it checks the outcome, not which commands fixed it.
 */
/**
 * `checkListener` = false checks only the path (used by SSH/Telnet clients, which tell "refused" from "timed out"
 * themselves).
 */
export function canReach(net: Network, fromDevice: string, dest: Ipv4, flow: Flow = PING, count = false, checkListener = true): boolean {
  const srcIp = sourceAddressFor(net, net.device(fromDevice), dest);
  if (srcIp === null) return false;
  const forward = walk(net, fromDevice, dest, 30, false, { packet: forwardPacket(flow), src: srcIp, count });
  if (!forward.delivered) return false;
  const destDevice = forward.hops.length ? forward.hops[forward.hops.length - 1].device : fromDevice;
  if (checkListener && !listens(net.device(destDevice), flow)) return false;
  const r = replyTarget(forward, srcIp);
  const reply = { ...replyPacket(flow), ...(r.dstPort !== undefined && flow.proto !== 'icmp' ? { dstPort: r.dstPort } : {}) };
  return walk(net, destDevice, r.to, 30, false, { packet: reply, src: r.from ?? dest, count, hints: r.hints }).delivered;
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
  const forward = walk(net, fromDevice, dest, 30, true, { packet: forwardPacket(PING) });
  let marks: string;
  let destDevice: string | null = null;
  if (!forward.delivered) {
    // A router along the path that has no route (or whose ACL denies the echo) answers with ICMP
    // unreachable, rate-limited: U.U.U
    const unreachable =
      (forward.failure === 'no-route' || forward.failure === 'acl') &&
      forward.failedAt !== fromDevice &&
      srcIp !== null &&
      walk(net, forward.failedAt!, forward.pkt?.src ?? srcIp, 30, true, { packet: { proto: 'icmp', icmpType: 'unreachable' }, hints: forward.translations }).delivered;
    marks = (unreachable ? 'U.' : '..').repeat(count).slice(0, count);
  } else {
    destDevice = forward.hops.length ? forward.hops[forward.hops.length - 1].device : fromDevice;
    const r = replyTarget(forward, srcIp ?? 0);
    const back = srcIp === null ? null : walk(net, destDevice, r.to, 30, true, { packet: replyPacket(PING), src: r.from ?? dest, hints: r.hints });
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
  /** Why it was unreachable: H = no route to host, A = administratively prohibited (an ACL). */
  code?: 'H' | 'A';
  rttMs: number[];
}

/** IOS traceroute sends UDP probes to high ports; Windows tracert sends ICMP echoes. */
export function traceroute(net: Network, fromDevice: string, dest: Ipv4, maxTtl = 30, style: 'ios' | 'windows' = 'ios'): TraceHop[] {
  const source = net.device(fromDevice);
  const srcIp = sourceAddressFor(net, source, dest);
  const probe: PacketSpec = style === 'ios' ? { proto: 'udp', srcPort: 49152, dstPort: 33434 } : forwardPacket(PING);
  const forward = walk(net, fromDevice, dest, maxTtl, true, { packet: probe });
  const result: TraceHop[] = [];
  const rtt = (n: number) => [0, 1, 2].map(() => n + net.rng.int(0, n + 1));
  forward.hops.forEach((hop, i) => {
    const isLast = forward.delivered && i === forward.hops.length - 1;
    const replyFrom = isLast ? dest : hop.ingressIp;
    const canReply =
      srcIp !== null && replyFrom !== null && walk(net, hop.device, hop.src ?? srcIp, 30, true, { packet: { proto: 'icmp', icmpType: 'time-exceeded' }, hints: forward.translations }).delivered;
    result.push({ ttl: i + 1, address: canReply ? replyFrom : null, unreachable: false, rttMs: rtt(i + 1) });
  });
  if (forward.delivered) return result;
  if (forward.failure === 'acl' && srcIp !== null && forward.hops.length) {
    // The filtering router answers "administratively prohibited" in place of the hop it would have shown.
    const last = result[result.length - 1];
    last.address = forward.hops[forward.hops.length - 1].ingressIp;
    last.unreachable = true;
    last.code = 'A';
    return result;
  }
  if (forward.failure === 'no-route' && forward.failedAt !== fromDevice && srcIp !== null) {
    const failed = net.device(forward.failedAt!);
    const lastHop = forward.hops[forward.hops.length - 1];
    if (walk(net, failed.id, forward.pkt?.src ?? srcIp, 30, true, { packet: { proto: 'icmp', icmpType: 'unreachable' }, hints: forward.translations }).delivered) {
      result.push({ ttl: result.length + 1, address: lastHop.ingressIp, unreachable: true, code: 'H', rttMs: rtt(result.length + 1) });
      return result;
    }
  }
  for (let ttl = result.length + 1; ttl <= maxTtl; ttl++) result.push({ ttl, address: null, unreachable: false, rttMs: [] });
  return result;
}

export function describeIp(ip: Ipv4 | null): string {
  return ip === null ? 'unassigned' : formatIp(ip);
}

