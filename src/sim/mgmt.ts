// Management-plane services: syslog (what reaches the NOC's Logs tab), device clocks and NTP, timestamps on log
// lines, and SNMP (what the NOC's Monitor tab can poll). All of it depends on config and on the path being open.

import { evaluate } from './acl';
import { formatIp, type Ipv4 } from './ip';
import type { Network } from './network';
import { canReach, ownsAddress } from './routing';
import type { Device } from './types';

export const SEVERITY_NAMES = ['emergencies', 'alerts', 'critical', 'errors', 'warnings', 'notifications', 'informational', 'debugging'];

export interface Timestamps {
  mode: 'datetime' | 'uptime' | 'none';
  msec: boolean;
  localtime: boolean;
  showTimezone: boolean;
}

export interface LoggingConfig {
  hosts: Ipv4[];
  /** Severity levels 0-7; a message is sent if its level <= the setting. */
  trap: number;
  console: number | null;
  monitor: number;
  buffered: { size: number; level: number } | null;
}

export interface SnmpConfig {
  communities: Record<string, { access: 'RO' | 'RW'; acl?: string }>;
  location: string | null;
  contact: string | null;
  groups: Record<string, 'noauth' | 'auth' | 'priv'>;
  users: Record<string, { group: string; auth: 'sha' | 'md5' | null; priv: 'aes' | 'des' | null }>;
}

export interface NtpConfig {
  servers: { ip: Ipv4; prefer: boolean }[];
  master: number | null;
}

export const DEFAULT_TIMESTAMPS: Timestamps = { mode: 'datetime', msec: true, localtime: false, showTimezone: false };
export const DEFAULT_LOGGING: LoggingConfig = { hosts: [], trap: 6, console: 7, monitor: 7, buffered: { size: 8192, level: 7 } };

export function loggingOf(device: Device): LoggingConfig {
  return device.running.logging ?? DEFAULT_LOGGING;
}

export function severityOf(message: string): number {
  const m = /^%[A-Z0-9_]+-(\d)-/.exec(message);
  return m ? Number(m[1]) : 6;
}

/** "warnings" or "4" -> 4. */
export function parseSeverity(text: string): number | null {
  if (/^[0-7]$/.test(text)) return Number(text);
  const i = SEVERITY_NAMES.findIndex((n) => n.startsWith(text.toLowerCase()));
  return i >= 0 && text.length >= 2 ? i : null;
}

// ---------------------------------------------------------------- clocks and NTP

/** Where an unsynchronized IOS clock starts: midnight, March 1st 1993, counted from boot. */
const IOS_DEFAULT_EPOCH = Date.UTC(1993, 2, 1);

export interface NtpState {
  synced: boolean;
  stratum: number;
  reference: Ipv4 | null;
}

/** Is this device a usable NTP source, and at what stratum? (CR-DC01 serves time like a Windows DC.) */
function sourceStratum(net: Network, server: Device, depth: number): number | null {
  if (!net.isOnline(server)) return null;
  if (server.kind === 'server' && server.dnsZone) return 2; // the domain controller, synced to the internet
  if (server.kind === 'pc' || server.kind === 'server' || server.kind === 'printer') return null;
  const ntp = server.running.ntp;
  if (ntp?.master != null) return ntp.master;
  if (depth <= 0) return null;
  const s = ntpState(net, server, depth - 1);
  return s.synced ? s.stratum : null;
}

export function ntpState(net: Network, device: Device, depth = 3): NtpState {
  const ntp = device.running.ntp;
  if (ntp?.master != null) return { synced: true, stratum: ntp.master, reference: 0x7f7f0101 }; // 127.127.1.1, the local clock
  const servers = [...(ntp?.servers ?? [])].sort((a, b) => Number(b.prefer) - Number(a.prefer));
  for (const s of servers) {
    const owner = [...net.devices.values()].find((d) => ownsAddress(net, d, s.ip));
    if (!owner) continue;
    const stratum = sourceStratum(net, owner, depth);
    if (stratum === null || stratum >= 15) continue;
    if (!canReach(net, device.id, s.ip, { proto: 'udp', port: 123 })) continue;
    return { synced: true, stratum: stratum + 1, reference: s.ip };
  }
  return { synced: false, stratum: 16, reference: null };
}

/** The device's own idea of the time, and whether IOS would mark it with '*' (not authoritative). */
export function deviceClock(net: Network, device: Device, time = net.time): { date: Date; authoritative: boolean } {
  if (device.kind === 'pc' || device.kind === 'server' || device.kind === 'printer') return { date: net.wallClock(time), authoritative: true };
  if (ntpState(net, device).synced) return { date: net.wallClock(time), authoritative: true };
  if (device.clockSetAt !== undefined && device.clockOffset !== undefined) {
    return { date: new Date(net.wallClock(time).getTime() + device.clockOffset), authoritative: true };
  }
  return { date: new Date(IOS_DEFAULT_EPOCH + Math.max(0, time - device.bootedAt)), authoritative: false };
}

function uptimeText(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d${String(h).padStart(2, '0')}h`;
  return [h, m, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

/** The timestamp IOS puts in front of a log line ("*Mar  1 00:02:13.420", "00:12:34", or nothing). */
export function logStamp(net: Network, device: Device, time: number): string {
  const ts = device.running.timestamps ?? DEFAULT_TIMESTAMPS;
  if (ts.mode === 'none') return '';
  if (ts.mode === 'uptime') return uptimeText(time - device.bootedAt);
  const { date: d, authoritative } = deviceClock(net, device, time);
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = String(d.getUTCDate()).padStart(2, ' ');
  const hms = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  const ms = ts.msec ? `.${String(d.getUTCMilliseconds()).padStart(3, '0')}` : '';
  return `${authoritative ? '' : '*'}${month} ${day} ${hms}${ms}${ts.showTimezone ? ' UTC' : ''}`;
}

// ---------------------------------------------------------------- syslog and SNMP from the NOC's point of view

/** Does this message reach the syslog collector (the NOC PC)? */
export function syslogDelivered(net: Network, device: Device, message: string, collector: Ipv4): boolean {
  if (device.kind === 'pc' || device.kind === 'server' || device.kind === 'printer' || !device.managed) return true;
  const cfg = loggingOf(device);
  if (!cfg.hosts.includes(collector) || severityOf(message) > cfg.trap) return false;
  return canReach(net, device.id, collector, { proto: 'udp', port: 514 });
}

export interface Poller {
  ip: Ipv4;
  community: string;
}

/** Would the NOC's SNMP poller get answers from this device? */
export function snmpAnswers(net: Network, device: Device, poller: Poller): boolean {
  if (device.kind === 'pc' || device.kind === 'server' || device.kind === 'printer') return true;
  const comm = device.running.snmp?.communities[poller.community];
  if (!comm) return false;
  if (comm.acl) {
    const acl = device.running.acls?.[comm.acl];
    if (acl && acl.entries.some((e) => e.remark === undefined) && !evaluate(acl, { proto: 'udp', src: poller.ip, dst: 0, dstPort: 161 }).permit) return false;
  }
  // The poller reaches any one of the device's addresses.
  const addrs = Object.values(device.running.interfaces).filter((i) => i.ip && !i.switchport).map((i) => i.ip!.address);
  return addrs.some((a) => canReach(net, findDevice(net, poller.ip), a, { proto: 'udp', port: 161 }));
}

function findDevice(net: Network, ip: Ipv4): string {
  for (const d of net.devices.values()) if (ownsAddress(net, d, ip)) return d.id;
  return '';
}

// ---------------------------------------------------------------- show output

export function showNtpStatus(net: Network, device: Device): string[] {
  const s = ntpState(net, device);
  const { date } = deviceClock(net, device);
  const ref = s.reference === null ? 'no reference clock' : `reference is ${s.reference === 0x7f7f0101 ? '127.127.1.1' : formatIp(s.reference)}`;
  return [
    `Clock is ${s.synced ? 'synchronized' : 'unsynchronized'}, stratum ${s.stratum}, ${ref}`,
    'nominal freq is 250.0000 Hz, actual freq is 250.0000 Hz, precision is 2**10',
    `ntp uptime is ${Math.floor((net.time - device.bootedAt) / 10)} (1/100 of seconds), resolution is 4000`,
    `reference time is ${s.synced ? `E1F2A3B4.1C28F5C2 (${date.toUTCString().slice(17, 25)}.000 UTC ${date.toUTCString().slice(0, 16)})` : '00000000.00000000 (00:00:00.000 UTC Mon Jan 1 1900)'}`,
    `clock offset is ${s.synced ? '0.5000' : '0.0000'} msec, root delay is ${s.synced ? '1.00' : '0.00'} msec`,
    `root dispersion is ${s.synced ? '18.45' : '0.00'} msec, peer dispersion is ${s.synced ? '0.12' : '0.00'} msec`,
    'loopfilter state is \'CTRL\' (Normal Controlled Loop), drift is 0.000000000 s/s',
    `system poll interval is 64, ${s.synced ? 'last update was 17 sec ago.' : 'never updated.'}`,
  ];
}

export function showNtpAssociations(net: Network, device: Device): string[] {
  const out = ['', '  address         ref clock       st   when   poll reach  delay  offset   disp'];
  const s = ntpState(net, device);
  for (const srv of device.running.ntp?.servers ?? []) {
    const chosen = s.reference === srv.ip;
    const owner = [...net.devices.values()].find((d) => ownsAddress(net, d, srv.ip));
    const ok = chosen || (owner && canReach(net, device.id, srv.ip, { proto: 'udp', port: 123 }));
    const st = chosen ? s.stratum - 1 : 16;
    const ref = chosen ? (st === 2 ? '.GPS.' : '10.10.20.10') : '.INIT.';
    out.push(
      `${chosen ? '*' : ' '}~${formatIp(srv.ip).padEnd(16)}${ref.padEnd(16)}${String(st).padStart(2)}${(ok ? '17' : '-').padStart(7)}${'64'.padStart(7)}${(ok ? '377' : '0').padStart(6)}${(ok ? '1.000' : '0.000').padStart(7)}${(ok ? '0.500' : '0.000').padStart(8)}${(ok ? '0.119' : '15937.').padStart(7)}`,
    );
  }
  out.push(' * sys.peer, # selected, + candidate, - outlyer, x falseticker, ~ configured');
  return out;
}

export function showLogging(net: Network, device: Device): string[] {
  const cfg = loggingOf(device);
  const mine = net.logs.filter((l) => l.device === device.id);
  const lvl = (n: number) => SEVERITY_NAMES[n];
  const out = [
    'Syslog logging: enabled (0 messages dropped, 0 messages rate-limited, 0 flushes, 0 overruns, xml disabled, filtering disabled)',
    '',
    'No Active Message Discriminator.',
    '',
    '',
    'No Inactive Message Discriminator.',
    '',
    '',
    cfg.console === null ? '    Console logging: disabled' : `    Console logging: level ${lvl(cfg.console)}, ${mine.length} messages logged, xml disabled,`,
    ...(cfg.console === null ? [] : ['                     filtering disabled']),
    `    Monitor logging: level ${lvl(cfg.monitor)}, 0 messages logged, xml disabled,`,
    '                     filtering disabled',
    cfg.buffered ? `    Buffer logging:  level ${lvl(cfg.buffered.level)}, ${mine.length} messages logged, xml disabled,` : '    Buffer logging:  disabled, xml disabled,',
    '                    filtering disabled',
    '    Exception Logging: size (4096 bytes)',
    '    Count and timestamp logging messages: disabled',
    '    Persistent logging: disabled',
    '',
    'No active filter modules.',
    '',
    `    Trap logging: level ${lvl(cfg.trap)}, ${mine.filter((l) => severityOf(l.message) <= cfg.trap).length} message lines logged`,
  ];
  for (const h of cfg.hosts) {
    const up = canReach(net, device.id, h, { proto: 'udp', port: 514 }, false, false);
    const sent = mine.filter((l) => severityOf(l.message) <= cfg.trap).length;
    out.push(
      `        Logging to ${formatIp(h)}  (udp port 514, audit disabled,`,
      `              link ${up ? 'up' : 'down'}),`,
      `              ${sent} message lines logged, `,
      '              0 message lines rate-limited, ',
      '              0 message lines dropped-by-MD, ',
      '              xml disabled, sequence number disabled',
      '              filtering disabled',
    );
  }
  out.push('        Logging Source-Interface:       VRF Name:', '');
  if (cfg.buffered) {
    out.push(`Log Buffer (${cfg.buffered.size} bytes):`, '');
    const lines = mine.filter((l) => severityOf(l.message) <= cfg.buffered!.level).map((l) => `${l.stamp ?? logStamp(net, device, l.time)}${l.stamp === '' ? '' : ': '}${l.message}`);
    // Keep roughly what fits in the buffer.
    let bytes = 0;
    const kept: string[] = [];
    for (let i = lines.length - 1; i >= 0 && bytes + lines[i].length < cfg.buffered.size; i--) {
      bytes += lines[i].length + 1;
      kept.unshift(lines[i]);
    }
    out.push(...kept);
  }
  return out;
}

/** Config lines: timestamps go near the top, logging/SNMP/NTP near the bottom. */
export function timestampLines(device: Device): string[] {
  const ts = device.running.timestamps ?? DEFAULT_TIMESTAMPS;
  const body =
    ts.mode === 'none'
      ? null
      : ts.mode === 'uptime'
        ? 'uptime'
        : `datetime${ts.msec ? ' msec' : ''}${ts.localtime ? ' localtime' : ''}${ts.showTimezone ? ' show-timezone' : ''}`;
  return ['service timestamps debug datetime msec', body === null ? 'no service timestamps log' : `service timestamps log ${body}`];
}

export function loggingTopLines(device: Device): string[] {
  const cfg = device.running.logging;
  if (!cfg) return [];
  const out: string[] = [];
  if (!cfg.buffered) out.push('no logging buffered');
  else if (cfg.buffered.size !== 8192 || cfg.buffered.level !== 7) out.push(`logging buffered ${cfg.buffered.size}${cfg.buffered.level !== 7 ? ` ${SEVERITY_NAMES[cfg.buffered.level]}` : ''}`);
  if (cfg.console === null) out.push('no logging console');
  else if (cfg.console !== 7) out.push(`logging console ${SEVERITY_NAMES[cfg.console]}`);
  if (cfg.monitor !== 7) out.push(`logging monitor ${SEVERITY_NAMES[cfg.monitor]}`);
  return out;
}

export function loggingBottomLines(device: Device): string[] {
  const out: string[] = [];
  const cfg = device.running.logging;
  if (cfg) {
    if (cfg.trap !== 6) out.push(`logging trap ${SEVERITY_NAMES[cfg.trap]}`);
    for (const h of cfg.hosts) out.push(`logging host ${formatIp(h)}`);
  }
  const snmp = device.running.snmp;
  if (snmp) {
    for (const [name, c] of Object.entries(snmp.communities)) out.push(`snmp-server community ${name} ${c.access}${c.acl ? ` ${c.acl}` : ''}`);
    if (snmp.location) out.push(`snmp-server location ${snmp.location}`);
    if (snmp.contact) out.push(`snmp-server contact ${snmp.contact}`);
    for (const [g, sec] of Object.entries(snmp.groups)) out.push(`snmp-server group ${g} v3 ${sec}`);
  }
  if (out.length) out.push('!');
  return out;
}

export function ntpLines(device: Device): string[] {
  const ntp = device.running.ntp;
  if (!ntp) return [];
  const out: string[] = [];
  if (ntp.master !== null) out.push(ntp.master === 8 ? 'ntp master' : `ntp master ${ntp.master}`);
  for (const s of ntp.servers) out.push(`ntp server ${formatIp(s.ip)}${s.prefer ? ' prefer' : ''}`);
  return out;
}
