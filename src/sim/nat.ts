// NAT/PAT on IOS routers: `ip nat inside|outside` on interfaces, dynamic rules (`ip nat inside source list ACL
// interface IF overload` or a pool), and static rules (one-to-one or port forwards).
//
// The walk calls natOutbound() when a packet crosses from an inside to an outside interface, and natInbound()
// when a packet arrives on an outside interface. Replies find their way back through `hints` (the translations
// made by the request), so the sim stays stateless where it can; real traffic also records entries in the
// router's translation table, which is what `show ip nat translations` shows and what limits non-overload NAT.

import { evaluate, type Packet } from './acl';
import { formatIp, type Ipv4 } from './ip';
import type { Network } from './network';
import type { Device } from './types';

export interface NatPool {
  start: Ipv4;
  end: Ipv4;
  prefix: number;
}

export type NatRule =
  | { kind: 'dynamic'; acl: string; iface?: string; pool?: string; overload: boolean }
  | { kind: 'static'; local: Ipv4; global: Ipv4; proto?: 'tcp' | 'udp'; localPort?: number; globalPort?: number; globalIface?: string; extendable?: boolean };

export interface NatConfig {
  pools: Record<string, NatPool>;
  rules: NatRule[];
}

/** One row of `show ip nat translations`. */
export interface NatEntry {
  proto: 'tcp' | 'udp' | 'icmp' | null;
  insideLocal: Ipv4;
  insideGlobal: Ipv4;
  localPort?: number;
  globalPort?: number;
  outside?: Ipv4;
  outsidePort?: number;
  lastUsed: number;
  static?: boolean;
}

export interface NatStats {
  hits: number;
  misses: number;
  expired: number;
  peak: number;
  peakAt: number;
}

/** A translation made on the way out, so the reply can be un-translated on the way back. */
export interface Translation {
  device: string;
  proto: Packet['proto'];
  local: Ipv4;
  global: Ipv4;
  localPort?: number;
  globalPort?: number;
}

const TIMEOUT_MS: Record<string, number> = { icmp: 60_000, udp: 300_000, tcp: 86_400_000 };

export function natConfig(device: Device): NatConfig | null {
  return device.running.nat ?? null;
}

function ifRole(device: Device, iface: string | undefined): 'inside' | 'outside' | null {
  if (!iface) return null;
  return device.running.interfaces[iface]?.nat ?? null;
}

function ifAddress(device: Device, iface: string | undefined): Ipv4 | null {
  if (!iface) return null;
  return device.running.interfaces[iface]?.ip?.address ?? null;
}

/** Drops expired dynamic entries. */
export function pruneNat(net: Network, device: Device): NatEntry[] {
  const table = (device.natTable ??= []);
  const before = table.length;
  device.natTable = table.filter((e) => e.static || net.time - e.lastUsed < TIMEOUT_MS[e.proto ?? 'tcp']);
  const stats = natStats(device);
  stats.expired += before - device.natTable.length;
  return device.natTable;
}

export function natStats(device: Device): NatStats {
  return (device.natStats ??= { hits: 0, misses: 0, expired: 0, peak: 0, peakAt: 0 });
}

function aclMatches(device: Device, name: string, pkt: Packet): boolean {
  const acl = device.running.acls?.[name];
  if (!acl) return false; // NAT with a missing ACL translates nothing
  return evaluate(acl, pkt).permit;
}

type Outcome = { global: Ipv4; globalPort?: number } | 'drop' | null;

/** Picks the inside global address/port for a packet, or 'drop' if a matching rule can't translate it. */
function chooseGlobal(net: Network, device: Device, pkt: Packet, record: boolean): Outcome {
  const cfg = natConfig(device)!;
  const table = pruneNat(net, device);
  const portful = pkt.proto === 'tcp' || pkt.proto === 'udp';
  // Static rules first: port forwards, then one-to-one.
  for (const r of cfg.rules) {
    if (r.kind !== 'static' || r.local !== pkt.src) continue;
    const global = r.globalIface ? ifAddress(device, r.globalIface) : r.global;
    if (global === null) continue;
    if (r.proto) {
      if (r.proto === pkt.proto && r.localPort === pkt.srcPort) return { global, globalPort: r.globalPort };
      continue;
    }
    return { global, globalPort: pkt.srcPort };
  }
  for (const r of cfg.rules) {
    if (r.kind !== 'dynamic' || !aclMatches(device, r.acl, pkt)) continue;
    // Addresses this rule may hand out.
    let addrs: Ipv4[] = [];
    if (r.iface) {
      const a = ifAddress(device, r.iface);
      if (a !== null) addrs = [a];
    } else if (r.pool && cfg.pools[r.pool]) {
      const p = cfg.pools[r.pool];
      for (let a = p.start; a <= p.end && addrs.length < 256; a++) addrs.push(a);
    }
    if (!addrs.length) return 'drop';
    if (r.overload) {
      const global = addrs[0];
      const key = (e: NatEntry) => e.proto === (portful || pkt.proto === 'icmp' ? pkt.proto : null) && e.insideLocal === pkt.src && e.localPort === pkt.srcPort;
      const existing = table.find((e) => key(e) && e.insideGlobal === global);
      if (existing) return { global, globalPort: existing.globalPort };
      // PAT keeps the source port if it's free on the global address, otherwise takes the next one.
      let port = pkt.srcPort ?? 1;
      const taken = new Set(table.filter((e) => e.insideGlobal === global && e.proto === pkt.proto).map((e) => e.globalPort));
      while (taken.has(port)) port++;
      return { global, globalPort: port };
    }
    // One-to-one dynamic: each inside host needs its own global address while its entries live.
    const mine = table.find((e) => !e.static && e.insideLocal === pkt.src && addrs.includes(e.insideGlobal));
    if (mine) return { global: mine.insideGlobal, globalPort: pkt.srcPort };
    const used = new Set(table.filter((e) => !e.static).map((e) => e.insideGlobal));
    const free = addrs.find((a) => !used.has(a));
    if (free === undefined) {
      if (record) natStats(device).misses++;
      return 'drop';
    }
    return { global: free, globalPort: pkt.srcPort };
  }
  return null;
}

/**
 * Inside -> outside. Returns the translation (and rewrites the packet's source), 'drop', or null when the
 * packet isn't crossing a NAT boundary or matches no rule (it leaves untranslated).
 */
export function natOutbound(net: Network, device: Device, ingress: string | undefined, egress: string, pkt: Packet, record: boolean): Translation | 'drop' | null {
  if (!natConfig(device) || ifRole(device, ingress) !== 'inside' || ifRole(device, egress) !== 'outside') return null;
  const choice = chooseGlobal(net, device, pkt, record);
  if (choice === null || choice === 'drop') return choice;
  const t: Translation = { device: device.id, proto: pkt.proto, local: pkt.src, global: choice.global, localPort: pkt.srcPort, globalPort: choice.globalPort };
  if (record) {
    const table = (device.natTable ??= []);
    const proto = pkt.proto === 'tcp' || pkt.proto === 'udp' || pkt.proto === 'icmp' ? pkt.proto : null;
    const existing = table.find((e) => !e.static && e.proto === proto && e.insideLocal === pkt.src && e.localPort === pkt.srcPort && e.outside === pkt.dst);
    if (existing) existing.lastUsed = net.time;
    else table.push({ proto, insideLocal: pkt.src, insideGlobal: choice.global, localPort: pkt.srcPort, globalPort: choice.globalPort, outside: pkt.dst, outsidePort: pkt.dstPort, lastUsed: net.time });
    const stats = natStats(device);
    stats.hits++;
    const active = table.length;
    if (active > stats.peak) {
      stats.peak = active;
      stats.peakAt = net.time;
    }
  }
  pkt.src = choice.global;
  if (choice.globalPort !== undefined) pkt.srcPort = choice.globalPort;
  return t;
}

/** Outside -> inside: un-translates the destination using the request's translations or a static rule. */
export function natInbound(device: Device, ingress: string, pkt: Packet, hints: Translation[]): boolean {
  const cfg = natConfig(device);
  if (!cfg || ifRole(device, ingress) !== 'outside') return false;
  const icmpError = pkt.proto === 'icmp' && (pkt.icmpType === 'unreachable' || pkt.icmpType === 'time-exceeded');
  const hint = hints.find(
    (t) => t.device === device.id && t.global === pkt.dst && (icmpError || (t.proto === pkt.proto && (pkt.proto === 'icmp' || t.globalPort === pkt.dstPort))),
  );
  if (hint) {
    pkt.dst = hint.local;
    if (hint.localPort !== undefined && !icmpError && pkt.proto !== 'icmp') pkt.dstPort = hint.localPort;
    return true;
  }
  for (const r of cfg.rules) {
    if (r.kind !== 'static') continue;
    const global = r.globalIface ? ifAddress(device, r.globalIface) : r.global;
    if (global !== pkt.dst) continue;
    if (r.proto) {
      if (r.proto !== pkt.proto || r.globalPort !== pkt.dstPort) continue;
      pkt.dst = r.local;
      pkt.dstPort = r.localPort;
      return true;
    }
    pkt.dst = r.local;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- show output

const hp = (ip: Ipv4, port?: number) => (port === undefined ? formatIp(ip) : `${formatIp(ip)}:${port}`);

export function showNatTranslations(net: Network, device: Device): string[] {
  const cfg = natConfig(device);
  const lines = ['Pro Inside global         Inside local          Outside local         Outside global'];
  for (const r of cfg?.rules ?? []) {
    if (r.kind !== 'static') continue;
    const global = r.globalIface ? ifAddress(device, r.globalIface) : r.global;
    if (global === null) continue;
    const pro = r.proto ?? '---';
    lines.push(`${pro.padEnd(4)}${hp(global, r.globalPort).padEnd(22)}${hp(r.local, r.localPort).padEnd(22)}${'---'.padEnd(22)}---`);
  }
  for (const e of pruneNat(net, device)) {
    const outside = e.outside !== undefined ? hp(e.outside, e.proto === 'icmp' ? e.globalPort : e.outsidePort) : '---';
    lines.push(`${(e.proto ?? '---').padEnd(4)}${hp(e.insideGlobal, e.globalPort).padEnd(22)}${hp(e.insideLocal, e.localPort).padEnd(22)}${outside.padEnd(22)}${outside}`);
  }
  return lines.length > 1 ? lines : [];
}

export function showNatStatistics(net: Network, device: Device, ago: (ms: number) => string): string[] {
  const cfg = natConfig(device);
  const table = pruneNat(net, device);
  const statics = (cfg?.rules ?? []).filter((r) => r.kind === 'static').length;
  const stats = natStats(device);
  const ifs = (role: 'inside' | 'outside') =>
    Object.values(device.running.interfaces)
      .filter((i) => i.nat === role)
      .map((i) => i.name)
      .join(', ');
  const lines = [
    `Total active translations: ${table.length + statics} (${statics} static, ${table.length} dynamic; ${table.filter((e) => e.globalPort !== undefined).length} extended)`,
    `Peak translations: ${stats.peak}${stats.peak ? `, occurred ${ago(net.time - stats.peakAt)} ago` : ''}`,
    'Outside interfaces:',
    `  ${ifs('outside')}`,
    'Inside interfaces: ',
    `  ${ifs('inside')}`,
    `Hits: ${stats.hits}  Misses: ${stats.misses}`,
    `CEF Translated packets: ${stats.hits}, CEF Punted packets: 0`,
    `Expired translations: ${stats.expired}`,
    'Dynamic mappings:',
  ];
  const dyn = (cfg?.rules ?? []).filter((r) => r.kind === 'dynamic');
  if (dyn.length) lines.push('-- Inside Source');
  dyn.forEach((r, i) => {
    if (r.kind !== 'dynamic') return;
    const refs = table.filter((e) => !e.static).length;
    if (r.iface) lines.push(`[Id: ${i + 1}] access-list ${r.acl} interface ${r.iface} refcount ${refs}`);
    else {
      const p = cfg!.pools[r.pool!];
      lines.push(`[Id: ${i + 1}] access-list ${r.acl} pool ${r.pool} refcount ${refs}`);
      if (p) {
        const total = p.end - p.start + 1;
        const used = new Set(table.map((e) => e.insideGlobal)).size;
        lines.push(` pool ${r.pool}: netmask ${formatIp(((0xffffffff << (32 - p.prefix)) >>> 0))}`, `\tstart ${formatIp(p.start)} end ${formatIp(p.end)}`, `\ttype generic, total addresses ${total}, allocated ${used} (${Math.round((used / total) * 100)}%), misses ${stats.misses}`);
      }
    }
  });
  lines.push('Total doors: 0', 'Appl doors: 0', 'Normal doors: 0', 'Queued Packets: 0');
  return lines;
}

/** `ip nat ...` lines for the running config. */
export function natConfigLines(cfg: NatConfig | undefined): string[] {
  if (!cfg) return [];
  const out: string[] = [];
  for (const [name, p] of Object.entries(cfg.pools)) {
    out.push(`ip nat pool ${name} ${formatIp(p.start)} ${formatIp(p.end)} netmask ${formatIp((0xffffffff << (32 - p.prefix)) >>> 0)}`);
  }
  for (const r of cfg.rules) {
    if (r.kind === 'dynamic') {
      out.push(`ip nat inside source list ${r.acl} ${r.iface ? `interface ${r.iface}` : `pool ${r.pool}`}${r.overload ? ' overload' : ''}`);
    } else if (r.proto) {
      const global = r.globalIface ? `interface ${r.globalIface}` : formatIp(r.global);
      out.push(`ip nat inside source static ${r.proto} ${formatIp(r.local)} ${r.localPort} ${global} ${r.globalPort}${r.extendable ? ' extendable' : ''}`);
    } else {
      out.push(`ip nat inside source static ${formatIp(r.local)} ${formatIp(r.global)}`);
    }
  }
  return out;
}
