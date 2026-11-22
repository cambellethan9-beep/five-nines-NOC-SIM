// The IOS DHCP server: `ip dhcp pool` (network, default-router, dns-server, domain-name, lease),
// `ip dhcp excluded-address`, bindings, and conflict detection (IOS pings an address before offering it).
// Pools are turned into the same DhcpScope shape the Windows server uses, so dhcp.ts serves both.

import { broadcastOf, formatIp, networkOf, prefixToMask, type Ipv4 } from './ip';
import type { Network } from './network';
import type { Device, DhcpScope } from './types';

export interface IosDhcpPool {
  network: Ipv4 | null;
  prefix: number | null;
  defaultRouter: Ipv4[];
  dnsServer: Ipv4[];
  domainName: string | null;
  /** null = infinite. Default is one day. */
  leaseMs: number | null;
}

export const DAY_MS = 24 * 3600_000;

export function newPool(): IosDhcpPool {
  return { network: null, prefix: null, defaultRouter: [], dnsServer: [], domainName: null, leaseMs: DAY_MS };
}

export function dhcpServiceOn(device: Device): boolean {
  return device.running.serviceDhcp !== false;
}

/** The pools of an IOS device as scopes, with bindings and conflicts kept on the device. */
export function iosScopes(device: Device): DhcpScope[] {
  if (!dhcpServiceOn(device)) return [];
  const pools = device.running.dhcpPools ?? {};
  const scopes: DhcpScope[] = [];
  for (const [name, p] of Object.entries(pools)) {
    if (p.network === null || p.prefix === null) continue;
    const bindings = ((device.dhcpBindings ??= {})[name] ??= {});
    scopes.push({
      network: p.network,
      prefix: p.prefix,
      start: p.network + 1,
      end: broadcastOf(p.network, p.prefix) - 1,
      gateway: p.defaultRouter[0] ?? null,
      dns: p.dnsServer[0] ?? null,
      reservations: {},
      leases: bindings,
      excluded: device.running.dhcpExcluded ?? [],
      conflicts: (device.dhcpConflicts ??= []),
      leaseMs: p.leaseMs,
      pool: name,
    });
  }
  return scopes;
}

// ---------------------------------------------------------------- show output

function stamp(net: Network, time: number): string {
  const d = net.wallClock(time);
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  let h = d.getUTCHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${month} ${String(d.getUTCDate()).padStart(2, '0')} ${d.getUTCFullYear()} ${String(h).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} ${ampm}`;
}

/** "001a.2b3c.4d5e" -> client-ID "0100.1a2b.3c4d.5e" (01 = Ethernet). */
function clientId(mac: string): string {
  const hex = '01' + mac.replace(/\./g, '');
  return hex.match(/.{1,4}/g)!.join('.');
}

export function showDhcpBinding(net: Network, device: Device): string[] {
  const out = [
    'Bindings from all pools not associated with VRF:',
    'IP address          Client-ID/              Lease expiration        Type',
    '                    Hardware address/',
    '                    User name',
  ];
  const pools = device.running.dhcpPools ?? {};
  for (const [name, bindings] of Object.entries(device.dhcpBindings ?? {})) {
    const lease = pools[name]?.leaseMs;
    for (const [mac, ip] of Object.entries(bindings).sort((a, b) => a[1] - b[1])) {
      const client = [...net.devices.values()].find((d) => Object.values(d.hardware).some((h) => h.mac === mac));
      const got = client?.hostNet?.lease?.obtainedAt ?? net.time;
      const exp = lease === null || lease === undefined ? 'Infinite' : stamp(net, got + lease);
      out.push(`${formatIp(ip).padEnd(20)}${clientId(mac).padEnd(24)}${exp.padEnd(24)}Automatic`);
    }
  }
  return out;
}

export function showDhcpPool(device: Device, only?: string): string[] {
  const out: string[] = [];
  for (const [name, p] of Object.entries(device.running.dhcpPools ?? {})) {
    if (only !== undefined && name !== only) continue;
    const leased = Object.keys(device.dhcpBindings?.[name] ?? {}).length;
    out.push('', `Pool ${name} :`, ' Utilization mark (high/low)    : 100 / 0', ' Subnet size (first/next)       : 0 / 0 ');
    if (p.network === null || p.prefix === null) {
      out.push(' Total addresses                : 0', ` Leased addresses               : ${leased}`, ' Pending event                  : none', ' 0 subnet is currently in the pool :');
      continue;
    }
    const first = p.network + 1;
    const last = broadcastOf(p.network, p.prefix) - 1;
    const used = Object.values(device.dhcpBindings?.[name] ?? {});
    const next = used.length ? Math.max(...used) + 1 : first;
    out.push(
      ` Total addresses                : ${last - first + 1}`,
      ` Leased addresses               : ${leased}`,
      ' Pending event                  : none',
      ' 1 subnet is currently in the pool :',
      ' Current index        IP address range                    Leased addresses',
      ` ${formatIp(next).padEnd(21)}${formatIp(first).padEnd(17)}- ${formatIp(last).padEnd(17)}${leased}`,
    );
  }
  return out;
}

export function showDhcpConflict(net: Network, device: Device): string[] {
  const out = ['IP address        Detection method   Detection time          VRF'];
  for (const c of device.dhcpConflicts ?? []) out.push(`${formatIp(c.ip).padEnd(18)}${'Ping'.padEnd(19)}${stamp(net, c.at)}`);
  return out;
}

/** Config lines: excluded addresses, then each pool block. */
export function dhcpConfigLines(device: Device): string[] {
  const cfg = device.running;
  const out: string[] = [];
  if (cfg.serviceDhcp === false) out.push('no service dhcp', '!');
  for (const [a, b] of cfg.dhcpExcluded ?? []) out.push(a === b ? `ip dhcp excluded-address ${formatIp(a)}` : `ip dhcp excluded-address ${formatIp(a)} ${formatIp(b)}`);
  if ((cfg.dhcpExcluded ?? []).length) out.push('!');
  for (const [name, p] of Object.entries(cfg.dhcpPools ?? {})) {
    out.push(`ip dhcp pool ${name}`);
    if (p.network !== null && p.prefix !== null) out.push(` network ${formatIp(networkOf(p.network, p.prefix))} ${formatIp(prefixToMask(p.prefix))}`);
    if (p.defaultRouter.length) out.push(` default-router ${p.defaultRouter.map(formatIp).join(' ')} `);
    if (p.dnsServer.length) out.push(` dns-server ${p.dnsServer.map(formatIp).join(' ')} `);
    if (p.domainName) out.push(` domain-name ${p.domainName}`);
    if (p.leaseMs === null) out.push(' lease infinite');
    else if (p.leaseMs !== DAY_MS) {
      const d = Math.floor(p.leaseMs / DAY_MS);
      const h = Math.floor((p.leaseMs % DAY_MS) / 3600_000);
      const m = Math.floor((p.leaseMs % 3600_000) / 60_000);
      out.push(` lease ${d}${h || m ? ` ${h}` : ''}${m ? ` ${m}` : ''}`);
    }
    out.push('!');
  }
  return out;
}
