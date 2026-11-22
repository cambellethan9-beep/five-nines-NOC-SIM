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
