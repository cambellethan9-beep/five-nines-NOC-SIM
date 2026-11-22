// DNS for PCs: queries go to the PC's DNS server (from DHCP or set statically), answers are cached
// like the Windows resolver cache. nslookup asks the server directly; ping uses the cache first.

import type { Ipv4 } from './ip';
import type { Network } from './network';
import { canReach, ownsAddress } from './routing';
import type { Device } from './types';

export const DOMAIN = 'cedarridge.local';
/** How long an answer stays in a PC's cache (game time). */
export const CACHE_TTL_MS = 60 * 60_000;

/** "cr-fs01" -> "cr-fs01.cedarridge.local" (Windows appends the DNS suffix to single-label names). */
export function fqdn(name: string): string {
  const n = name.trim().toLowerCase().replace(/\.$/, '');
  return n.includes('.') ? n : `${n}.${DOMAIN}`;
}

export function dnsServerOf(device: Device): Ipv4 | null {
  const hn = device.hostNet;
  if (!hn) return null;
  // A manually entered DNS server wins over the one DHCP hands out.
  return hn.dhcp ? (hn.dnsServer ?? hn.lease?.dns ?? null) : hn.dnsServer;
}

export type DnsAnswer = { ok: true; ip: Ipv4; server: Ipv4 } | { ok: false; reason: 'no-server' | 'timeout' | 'nxdomain'; server: Ipv4 | null };

/** Asks the PC's DNS server directly (what nslookup does). */
export function queryServer(net: Network, pcId: string, name: string): DnsAnswer {
  const pc = net.device(pcId);
  const server = dnsServerOf(pc);
  if (server === null) return { ok: false, reason: 'no-server', server };
  const host = [...net.devices.values()].find((d) => d.dnsZone && net.isOnline(d) && ownsAddress(net, d, server));
  if (!host || !canReach(net, pcId, server, { proto: 'udp', port: 53 })) return { ok: false, reason: 'timeout', server };
  const ip = host.dnsZone![fqdn(name)];
  return ip === undefined ? { ok: false, reason: 'nxdomain', server } : { ok: true, ip, server };
}

export type Resolution = { ok: true; ip: Ipv4; fromCache: boolean } | { ok: false; reason: 'no-server' | 'timeout' | 'nxdomain' };

/** What ping, browsers and apps do: cache first, then the DNS server, caching the answer. */
export function resolve(net: Network, pcId: string, name: string): Resolution {
  const pc = net.device(pcId);
  const key = fqdn(name);
  const cache = pc.hostNet?.dnsCache;
  const hit = cache?.[key];
  if (hit && hit.expires > net.time) return { ok: true, ip: hit.ip, fromCache: true };
  const answer = queryServer(net, pcId, key);
  if (!answer.ok) return { ok: false, reason: answer.reason };
  if (cache) cache[key] = { ip: answer.ip, expires: net.time + CACHE_TTL_MS };
  return { ok: true, ip: answer.ip, fromCache: false };
}

export function flushDns(pc: Device): void {
  if (pc.hostNet) pc.hostNet.dnsCache = {};
}

// ---------------------------------------------------------------- IOS resolver

export type IosLookup = { ok: true; ip: Ipv4; server: Ipv4 | null } | { ok: false; server: Ipv4 | null; reason: 'off' | 'no-server' | 'timeout' | 'nxdomain' };

/** The name server IOS shows in "Translating ... domain server (X)". 255.255.255.255 = broadcast (none set). */
export function iosNameServer(device: Device): Ipv4 {
  return device.running.nameServers?.[0] ?? 0xffffffff;
}

/**
 * IOS name lookup: `ip host` entries first, then (with `ip domain-lookup`) each `ip name-server` in turn,
 * appending `ip domain-name` to single-label names. Answers are cached as temp entries (`show hosts`).
 */
export function iosResolve(net: Network, deviceId: string, name: string): IosLookup {
  const dev = net.device(deviceId);
  const key = name.toLowerCase();
  const stat = Object.entries(dev.running.hosts ?? {}).find(([n]) => n.toLowerCase() === key);
  if (stat) return { ok: true, ip: stat[1], server: null };
  if (!dev.running.domainLookup) return { ok: false, server: null, reason: 'off' };
  const servers = dev.running.nameServers ?? [];
  if (!servers.length) return { ok: false, server: 0xffffffff, reason: 'no-server' };
  const fq = key.includes('.') || !dev.running.domainName ? key : `${key}.${dev.running.domainName.toLowerCase()}`;
  const cached = dev.hostCache?.[fq];
  if (cached) return { ok: true, ip: cached.ip, server: servers[0] };
  for (const server of servers) {
    const host = [...net.devices.values()].find((d) => d.dnsZone && net.isOnline(d) && ownsAddress(net, d, server));
    if (!host || !canReach(net, deviceId, server, { proto: 'udp', port: 53 })) continue;
    const ip = host.dnsZone![fq];
    if (ip === undefined) return { ok: false, server, reason: 'nxdomain' };
    (dev.hostCache ??= {})[fq] = { ip, at: net.time };
    return { ok: true, ip, server };
  }
  return { ok: false, server: servers[0], reason: 'timeout' };
}
