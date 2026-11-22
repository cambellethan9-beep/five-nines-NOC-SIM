// IPv4 access lists: standard (source only), extended (protocol, source, destination, ports), numbered and named.
// Parsing follows IOS syntax closely (including its normalizing of host bits and the classic mask-as-wildcard
// mistake), matching is first-match with an implicit deny, and rendering matches `show run` / `show access-lists`.

import { formatIp, parseIp, type Ipv4 } from './ip';

export type AclType = 'standard' | 'extended';
export type Proto = 'ip' | 'tcp' | 'udp' | 'icmp' | 'ospf' | 'eigrp' | 'gre' | 'esp' | 'ahp' | 'pim';
export const PROTOS: Proto[] = ['ip', 'tcp', 'udp', 'icmp', 'ospf', 'eigrp', 'gre', 'esp', 'ahp', 'pim'];

export interface AddrSpec {
  addr: Ipv4;
  wildcard: Ipv4;
}

export interface PortSpec {
  op: 'eq' | 'neq' | 'lt' | 'gt' | 'range';
  ports: number[];
}

export interface AclEntry {
  seq: number;
  /** A remark line; nothing else is set. */
  remark?: string;
  action?: 'permit' | 'deny';
  proto?: Proto;
  src?: AddrSpec;
  srcPort?: PortSpec;
  dst?: AddrSpec;
  dstPort?: PortSpec;
  icmpType?: string;
  established?: boolean;
  log?: boolean;
  /** `time-range NAME`: the entry only counts while the range is active. */
  timeRange?: string;
  /** `reflect NAME [timeout S]`: traffic matching this entry opens the reflexive list NAME for its replies. */
  reflect?: { name: string; timeout?: number };
  /** `evaluate NAME`: permits replies to traffic a `reflect NAME` entry let out. */
  evaluate?: string;
}

/** `time-range NAME`: periodic and absolute windows, judged by the device's own clock. */
export interface TimeRange {
  /** `periodic weekdays 8:00 to 17:00`; `toDay` for spans like `Monday 22:00 to Tuesday 6:00`. */
  periodic: { days: string[]; from: string; to: string; toDay?: string }[];
  absolute: { start: string | null; end: string | null } | null;
}

/** What evaluating an ACL may need besides the packet: the clock and time ranges, and the other ACLs (reflexive). */
export interface AclEnv {
  now?: Date;
  ranges?: Record<string, TimeRange>;
  acls?: Record<string, Acl>;
}

export interface Acl {
  name: string;
  type: AclType;
  /** Created with `ip access-list` (shown as a block in the config) rather than `access-list N`. */
  named: boolean;
  entries: AclEntry[];
}

/** A packet as the ACL sees it. */
export interface Packet {
  proto: 'icmp' | 'tcp' | 'udp' | 'ospf' | 'eigrp';
  src: Ipv4;
  dst: Ipv4;
  srcPort?: number;
  dstPort?: number;
  icmpType?: 'echo' | 'echo-reply' | 'unreachable' | 'time-exceeded';
  /** TCP segment with ACK or RST set (a reply on an existing connection). */
  established?: boolean;
}

export const PORT_NAMES: Record<string, number> = {
  bgp: 179, chargen: 19, cmd: 514, daytime: 13, discard: 9, domain: 53, echo: 7, exec: 512, finger: 79, ftp: 21,
  'ftp-data': 20, gopher: 70, hostname: 101, ident: 113, irc: 194, klogin: 543, kshell: 544, login: 513, lpd: 515,
  nntp: 119, pop2: 109, pop3: 110, smtp: 25, sunrpc: 111, tacacs: 49, talk: 517, telnet: 23, time: 37, uucp: 540,
  whois: 43, www: 80,
};
export const UDP_PORT_NAMES: Record<string, number> = {
  biff: 512, bootpc: 68, bootps: 67, discard: 9, dnsix: 195, domain: 53, echo: 7, isakmp: 500, 'mobile-ip': 434,
  nameserver: 42, 'netbios-dgm': 138, 'netbios-ns': 137, 'netbios-ss': 139, ntp: 123, rip: 520, snmp: 161,
  snmptrap: 162, sunrpc: 111, syslog: 514, tacacs: 49, talk: 517, tftp: 69, time: 37, who: 513, xdmcp: 177,
};
const ICMP_TYPES = ['echo', 'echo-reply', 'unreachable', 'time-exceeded', 'administratively-prohibited', 'host-unreachable', 'net-unreachable', 'ttl-exceeded', 'redirect', 'packet-too-big'];

export function isStandardNumber(n: number): boolean {
  return (n >= 1 && n <= 99) || (n >= 1300 && n <= 1999);
}
export function isExtendedNumber(n: number): boolean {
  return (n >= 100 && n <= 199) || (n >= 2000 && n <= 2699);
}

// ---------------------------------------------------------------- parsing

export type EntryParse = { ok: true; entry: Omit<AclEntry, 'seq'> } | { ok: false; caret: number; incomplete?: boolean };

interface Tok {
  t: string;
  at: number;
}

function toks(text: string, base: number): Tok[] {
  const out: Tok[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ t: m[0], at: base + m.index });
  return out;
}

/** Unique-prefix keyword match like the IOS parser ("perm" -> permit). */
function kw(word: string | undefined, options: string[]): string | null {
  if (!word) return null;
  const w = word.toLowerCase();
  if (options.includes(w)) return w;
  const m = options.filter((o) => o.startsWith(w));
  return m.length === 1 ? m[0] : null;
}

function readAddr(ts: Tok[], i: number): { spec: AddrSpec; next: number } | { caret: number; incomplete?: boolean } {
  const t = ts[i];
  if (!t) return { caret: -1, incomplete: true };
  const k = kw(t.t, ['any', 'host']);
  if (k === 'any') return { spec: { addr: 0, wildcard: 0xffffffff }, next: i + 1 };
  if (k === 'host') {
    const a = ts[i + 1];
    if (!a) return { caret: -1, incomplete: true };
    const ip = parseIp(a.t);
    if (ip === null) return { caret: a.at };
    return { spec: { addr: ip, wildcard: 0 }, next: i + 2 };
  }
  const ip = parseIp(t.t);
  if (ip === null) return { caret: t.at };
  const w = ts[i + 1];
  const wild = w ? parseIp(w.t) : null;
  if (wild === null) return { caret: -1, incomplete: true };
  // IOS stores the address with the wildcard bits cleared.
  return { spec: { addr: (ip & ~wild) >>> 0, wildcard: wild }, next: i + 2 };
}

/** Standard ACL source: "any", "host A", "A" (host) or "A W". */
function readStdSource(ts: Tok[], i: number): { spec: AddrSpec; next: number } | { caret: number; incomplete?: boolean } {
  const t = ts[i];
  if (!t) return { caret: -1, incomplete: true };
  if (kw(t.t, ['any', 'host'])) return readAddr(ts, i);
  const ip = parseIp(t.t);
  if (ip === null) return { caret: t.at };
  const w = ts[i + 1];
  if (w && parseIp(w.t) !== null) return readAddr(ts, i);
  return { spec: { addr: ip, wildcard: 0 }, next: i + 1 };
}

function readPort(ts: Tok[], i: number, proto: Proto): { spec?: PortSpec; next: number } | { caret: number; incomplete?: boolean } {
  const op = kw(ts[i]?.t, ['eq', 'neq', 'lt', 'gt', 'range']) as PortSpec['op'] | null;
  if (!op || (proto !== 'tcp' && proto !== 'udp')) return { next: i };
  const names = proto === 'tcp' ? PORT_NAMES : UDP_PORT_NAMES;
  const one = (tok: Tok | undefined): number | { caret: number; incomplete?: boolean } => {
    if (!tok) return { caret: -1, incomplete: true };
    if (/^\d+$/.test(tok.t)) {
      const n = Number(tok.t);
      return n <= 65535 ? n : { caret: tok.at };
    }
    const named = kw(tok.t, Object.keys(names));
    return named ? names[named] : { caret: tok.at };
  };
  const a = one(ts[i + 1]);
  if (typeof a !== 'number') return a;
  if (op !== 'range') return { spec: { op, ports: [a] }, next: i + 2 };
  const b = one(ts[i + 2]);
  if (typeof b !== 'number') return b;
  return { spec: { op, ports: [a, b] }, next: i + 3 };
}

/** Parses "permit tcp any host 10.1.1.1 eq 443 log" (text after the sequence number, if any). */
export function parseEntry(type: AclType, text: string, base = 0, opts: { named?: boolean } = {}): EntryParse {
  const ts = toks(text, base);
  const fail = (r: { caret: number; incomplete?: boolean }): EntryParse => ({ ok: false, caret: r.caret, incomplete: r.incomplete || r.caret < 0 });
  const action = kw(ts[0]?.t, ['permit', 'deny']) as 'permit' | 'deny' | null;
  if (!action) return ts[0] ? { ok: false, caret: ts[0].at } : { ok: false, caret: -1, incomplete: true };
  const entry: Omit<AclEntry, 'seq'> = { action };
  let i = 1;
  if (type === 'standard') {
    const s = readStdSource(ts, i);
    if (!('spec' in s)) return fail(s);
    entry.src = s.spec;
    i = s.next;
  } else {
    let proto = kw(ts[i]?.t, PROTOS) as Proto | null;
    if (!proto && ts[i] && /^\d+$/.test(ts[i].t)) {
      const n = Number(ts[i].t);
      proto = n === 6 ? 'tcp' : n === 17 ? 'udp' : n === 1 ? 'icmp' : n === 89 ? 'ospf' : n === 88 ? 'eigrp' : n === 47 ? 'gre' : null;
    }
    if (!proto) return ts[i] ? { ok: false, caret: ts[i].at } : { ok: false, caret: -1, incomplete: true };
    entry.proto = proto;
    i++;
    const s = readAddr(ts, i);
    if (!('spec' in s)) return fail(s);
    entry.src = s.spec;
    i = s.next;
    const sp = readPort(ts, i, proto);
    if (!('next' in sp)) return fail(sp);
    if (sp.spec) entry.srcPort = sp.spec;
    i = sp.next;
    const d = readAddr(ts, i);
    if (!('spec' in d)) return fail(d);
    entry.dst = d.spec;
    i = d.next;
    const dp = readPort(ts, i, proto);
    if (!('next' in dp)) return fail(dp);
    if (dp.spec) entry.dstPort = dp.spec;
    i = dp.next;
    if (proto === 'icmp' && ts[i]) {
      const it = kw(ts[i].t, ICMP_TYPES);
      if (it) {
        entry.icmpType = it;
        i++;
      }
    }
    if (proto === 'tcp' && kw(ts[i]?.t, ['established']) === 'established') {
      entry.established = true;
      i++;
    }
  }
  if (ts[i] && kw(ts[i].t, ['log', 'log-input'])) {
    entry.log = true;
    i++;
  }
  if (ts[i] && type === 'extended' && kw(ts[i].t, ['reflect', 'time-range']) === 'reflect') {
    if (!opts.named) return { ok: false, caret: ts[i].at };
    const n = ts[i + 1];
    if (!n) return { ok: false, caret: -1, incomplete: true };
    entry.reflect = { name: n.t };
    i += 2;
    if (kw(ts[i]?.t, ['timeout']) === 'timeout') {
      const v = ts[i + 1];
      if (!v) return { ok: false, caret: -1, incomplete: true };
      if (!/^\d+$/.test(v.t) || Number(v.t) < 1 || Number(v.t) > 2147483) return { ok: false, caret: v.at };
      entry.reflect.timeout = Number(v.t);
      i += 2;
    }
  }
  if (ts[i] && kw(ts[i].t, ['time-range', 'timeout']) === 'time-range') {
    const n = ts[i + 1];
    if (!n) return { ok: false, caret: -1, incomplete: true };
    entry.timeRange = n.t;
    i += 2;
  }
  if (ts[i]) return { ok: false, caret: ts[i].at };
  return { ok: true, entry };
}

// ---------------------------------------------------------------- matching

function addrMatch(spec: AddrSpec | undefined, ip: Ipv4): boolean {
  if (!spec) return true;
  return ((ip & ~spec.wildcard) >>> 0) === ((spec.addr & ~spec.wildcard) >>> 0);
}

function portMatch(spec: PortSpec | undefined, port: number | undefined): boolean {
  if (!spec) return true;
  if (port === undefined) return false;
  const [a, b] = spec.ports;
  switch (spec.op) {
    case 'eq':
      return port === a;
    case 'neq':
      return port !== a;
    case 'lt':
      return port < a;
    case 'gt':
      return port > a;
    case 'range':
      return port >= a && port <= b;
  }
}

const ICMP_ALIASES: Record<string, string[]> = {
  unreachable: ['unreachable', 'administratively-prohibited', 'host-unreachable', 'net-unreachable'],
  'time-exceeded': ['time-exceeded', 'ttl-exceeded'],
};

export function entryMatches(type: AclType, e: AclEntry, p: Packet): boolean {
  if (e.remark !== undefined) return false;
  if (!addrMatch(e.src, p.src)) return false;
  if (type === 'standard') return true;
  if (e.proto !== 'ip' && e.proto !== p.proto) return false;
  if (!addrMatch(e.dst, p.dst)) return false;
  if (e.srcPort && !portMatch(e.srcPort, p.srcPort)) return false;
  if (e.dstPort && !portMatch(e.dstPort, p.dstPort)) return false;
  if (e.icmpType && !(ICMP_ALIASES[p.icmpType ?? '']?.includes(e.icmpType) || e.icmpType === p.icmpType)) return false;
  if (e.established && !p.established) return false;
  return true;
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** "08:00 14 April 2026" -> UTC ms (IOS time-range absolute format: hh:mm day month year). */
export function parseAbsolute(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const mon = MONTHS.indexOf(m[4].slice(0, 3).toLowerCase());
  if (mon < 0 || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Date.UTC(Number(m[5]), mon, Number(m[3]), Number(m[1]), Number(m[2]));
}

/** Expands "weekdays", "weekend", "daily" and day names to day indexes (0 = Sunday). */
export const DAY_WORDS = ['daily', 'weekdays', 'weekend', ...DAY_NAMES];

export function dayIndexes(days: string[]): number[] {
  const out = new Set<number>();
  for (const d of days) {
    const k = d.toLowerCase();
    if (k === 'daily') [0, 1, 2, 3, 4, 5, 6].forEach((x) => out.add(x));
    else if (k === 'weekdays') [1, 2, 3, 4, 5].forEach((x) => out.add(x));
    else if (k === 'weekend') [0, 6].forEach((x) => out.add(x));
    else if (DAY_NAMES.includes(k)) out.add(DAY_NAMES.indexOf(k));
  }
  return [...out];
}

/** Is the time range active at this moment? A range that doesn't exist is treated as active, like IOS. */
export function rangeActive(r: TimeRange | undefined, now: Date): boolean {
  if (!r) return true;
  const t = now.getTime();
  if (r.absolute) {
    const start = r.absolute.start ? parseAbsolute(r.absolute.start) : null;
    const end = r.absolute.end ? parseAbsolute(r.absolute.end) : null;
    if (start !== null && t < start) return false;
    if (end !== null && t > end) return false;
  }
  if (!r.periodic.length) return true;
  const day = now.getUTCDay();
  const min = now.getUTCHours() * 60 + now.getUTCMinutes();
  return r.periodic.some((p) => {
    const from = minutesOf(p.from);
    const to = minutesOf(p.to);
    const days = dayIndexes(p.days);
    if (p.toDay) {
      const d0 = DAY_NAMES.indexOf(p.days[0].toLowerCase());
      const d1 = DAY_NAMES.indexOf(p.toDay.toLowerCase());
      const now7 = day * 1440 + min;
      const a = d0 * 1440 + from;
      let b = d1 * 1440 + to;
      if (b < a) b += 7 * 1440;
      return (now7 >= a && now7 <= b) || (now7 + 7 * 1440 >= a && now7 + 7 * 1440 <= b);
    }
    return days.includes(day) && min >= from && min <= to;
  });
}

/** The packet a reply answers: addresses and ports swapped. */
function reversed(p: Packet): Packet {
  const icmp = p.icmpType === 'echo-reply' ? 'echo' : p.icmpType;
  return { proto: p.proto, src: p.dst, dst: p.src, srcPort: p.dstPort, dstPort: p.srcPort, ...(icmp ? { icmpType: icmp } : {}) };
}

/** First match wins; no match is the implicit deny. Returns the matching entry's seq (or null). */
export function evaluate(acl: Acl, p: Packet, env: AclEnv = {}): { permit: boolean; seq: number | null } {
  for (const e of acl.entries) {
    if (e.evaluate !== undefined) {
      // Reflexive: a reply whose request went out through a `reflect NAME` entry.
      // Only replies get through: a reflexive entry exists because the conversation started inside.
      const reply = p.proto === 'tcp' ? !!p.established : p.proto === 'icmp' ? p.icmpType !== 'echo' : p.proto === 'udp' ? (p.dstPort ?? 0) >= 1024 && (p.srcPort ?? 0) < 1024 : false;
      const back = reversed(p);
      const opened =
        reply && Object.values(env.acls ?? {}).some((other) =>
        other.entries.some((x) => x.reflect?.name === e.evaluate && x.action === 'permit' && entryMatches(other.type, x, back) && rangeActive(env.ranges?.[x.timeRange ?? ''], env.now ?? new Date(0)) && firstMatch(other, back, env)?.seq === x.seq),
      );
      if (opened) return { permit: true, seq: e.seq };
      continue;
    }
    if (e.timeRange && env.now && !rangeActive(env.ranges?.[e.timeRange], env.now)) continue;
    if (entryMatches(acl.type, e, p)) return { permit: e.action === 'permit', seq: e.seq };
  }
  return { permit: false, seq: null };
}

function firstMatch(acl: Acl, p: Packet, env: AclEnv): AclEntry | null {
  for (const e of acl.entries) {
    if (e.evaluate !== undefined || e.remark !== undefined) continue;
    if (e.timeRange && env.now && !rangeActive(env.ranges?.[e.timeRange], env.now)) continue;
    if (entryMatches(acl.type, e, p)) return e;
  }
  return null;
}

// ---------------------------------------------------------------- rendering

function addrText(a: AddrSpec, standard: boolean, showStyle: boolean): string {
  if (a.wildcard === 0xffffffff) return 'any';
  if (a.wildcard === 0) return standard ? formatIp(a.addr) : `host ${formatIp(a.addr)}`;
  if (standard && showStyle) return `${formatIp(a.addr)}, wildcard bits ${formatIp(a.wildcard)}`;
  return `${formatIp(a.addr)} ${formatIp(a.wildcard)}`;
}

function portText(p: PortSpec, proto: Proto): string {
  const names = proto === 'tcp' ? PORT_NAMES : UDP_PORT_NAMES;
  const name = (n: number) => Object.entries(names).find(([, v]) => v === n)?.[0] ?? String(n);
  return `${p.op} ${p.ports.map(name).join(' ')}`;
}

/** The entry body as IOS prints it ("permit tcp any host 10.1.1.1 eq 443"). */
export function entryText(type: AclType, e: AclEntry, showStyle = false): string {
  if (e.remark !== undefined) return `remark ${e.remark}`;
  if (e.evaluate !== undefined) return `evaluate ${e.evaluate}`;
  const action = type === 'standard' && e.action === 'deny' ? 'deny  ' : e.action!;
  if (type === 'standard') return `${action} ${addrText(e.src!, true, showStyle)}${e.log ? ' log' : ''}`;
  const parts = [e.action!, e.proto!, addrText(e.src!, false, false)];
  if (e.srcPort) parts.push(portText(e.srcPort, e.proto!));
  parts.push(addrText(e.dst!, false, false));
  if (e.dstPort) parts.push(portText(e.dstPort, e.proto!));
  if (e.icmpType) parts.push(e.icmpType);
  if (e.established) parts.push('established');
  if (e.log) parts.push('log');
  if (e.reflect) parts.push(`reflect ${e.reflect.name}${e.reflect.timeout ? ` timeout ${e.reflect.timeout}` : ''}`);
  if (e.timeRange) parts.push(`time-range ${e.timeRange}`);
  return parts.join(' ');
}

/** Lines for `show running-config`. */
export function aclConfigLines(acls: Record<string, Acl>): string[] {
  const out: string[] = [];
  const sorted = Object.values(acls).sort((a, b) => {
    const na = /^\d+$/.test(a.name) ? Number(a.name) : Infinity;
    const nb = /^\d+$/.test(b.name) ? Number(b.name) : Infinity;
    return na - nb || a.name.localeCompare(b.name);
  });
  for (const acl of sorted.filter((a) => a.named)) {
    out.push(`ip access-list ${acl.type} ${acl.name}`);
    for (const e of acl.entries) out.push(` ${entryText(acl.type, e)}`);
  }
  for (const acl of sorted.filter((a) => !a.named)) {
    for (const e of acl.entries) out.push(`access-list ${acl.name} ${entryText(acl.type, e)}`);
  }
  return out;
}

/** `show access-lists` for one list. */
export function showAcl(acl: Acl, hits: Record<string, number>, env: AclEnv = {}): string[] {
  const out = [`${acl.type === 'standard' ? 'Standard' : 'Extended'} IP access list ${acl.name}`];
  for (const e of acl.entries) {
    if (e.remark !== undefined) continue;
    const n = hits[`${acl.name}:${e.seq}`] ?? 0;
    const state = e.timeRange && env.now ? (env.ranges?.[e.timeRange] ? (rangeActive(env.ranges[e.timeRange], env.now) ? ' (active)' : ' (inactive)') : ' (active)') : '';
    out.push(`    ${e.seq} ${entryText(acl.type, e, true)}${state}${n ? ` (${n} match${n === 1 ? '' : 'es'})` : ''}`);
  }
  return out;
}

/** `show access-lists` lists the reflexive lists too, with the temporary entries currently open. */
export function reflexiveNames(acls: Record<string, Acl>): string[] {
  return [...new Set(Object.values(acls).flatMap((a) => a.entries.map((e) => e.reflect?.name).filter((n): n is string => !!n)))];
}

/** `ip access-list resequence NAME START STEP`. */
export function resequence(acl: Acl, start: number, step: number): void {
  let n = start;
  for (const e of acl.entries) {
    if (e.remark !== undefined) continue;
    e.seq = n;
    n += step;
  }
  // Remarks stay just before the entry that followed them.
  for (let i = 0; i < acl.entries.length; i++) {
    const e = acl.entries[i];
    if (e.remark === undefined) continue;
    const next = acl.entries.slice(i + 1).find((x) => x.remark === undefined);
    e.seq = (next ? next.seq : n) - 0.5;
  }
  acl.entries.sort((a, b) => a.seq - b.seq);
}

/** Inserts an entry by sequence number (or at the end, +10). Returns an error message or null. */
export function addEntry(acl: Acl, entry: Omit<AclEntry, 'seq'>, seq?: number): string | null {
  if (seq !== undefined && acl.entries.some((e) => e.seq === seq)) return '% Duplicate sequence number';
  // IOS ignores an exact duplicate of an existing entry.
  const same = acl.entries.find((e) => JSON.stringify({ ...e, seq: 0 }) === JSON.stringify({ ...entry, seq: 0 }));
  if (same && entry.remark === undefined) return null;
  // Remarks don't take a sequence number of their own: they sit just before the entry that follows them.
  const real = acl.entries.filter((e) => e.remark === undefined);
  const last = real.length ? Math.floor(real[real.length - 1].seq) : 0;
  const s = seq ?? (entry.remark !== undefined ? last + 9.5 : last + 10);
  acl.entries.push({ ...entry, seq: s });
  acl.entries.sort((a, b) => a.seq - b.seq);
  return null;
}
