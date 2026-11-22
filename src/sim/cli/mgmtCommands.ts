// Syslog, timestamps, NTP and SNMP commands, plus `show logging|ntp|snmp` and `clock set`.

import { parseIp } from '../ip';
import {
  DEFAULT_LOGGING,
  DEFAULT_TIMESTAMPS,
  parseSeverity,
  showLogging,
  showNtpAssociations,
  showNtpStatus,
  type LoggingConfig,
  type SnmpConfig,
  type NtpConfig,
} from '../mgmt';
import { caret, commit, type Ctx, type Tree } from './context';
import type { Args } from './parser';

const HM: Record<string, string> = {
  logging: 'Modify message logging facilities',
  host: 'Set syslog server IP address and parameters',
  addr: 'IP address of the logging host',
  trap: 'Set syslog server logging level',
  level: 'Logging severity level',
  buffered: 'Set buffered logging parameters',
  arg: 'Logging buffer size or severity level',
  size: 'Logging buffer size',
  console: 'Set console logging parameters',
  monitor: 'Set terminal line (monitor) logging parameters',
  service: 'Modify use of network based services',
  timestamps: 'Timestamp debug/log messages',
  log: 'Timestamp log messages',
  debug: 'Timestamp debug messages',
  datetime: 'Timestamp with date and time',
  uptime: 'Timestamp with system uptime',
  opts: 'msec | localtime | show-timezone',
  ntp: 'Configure NTP',
  server: 'Configure NTP server',
  prefer: 'Prefer this peer when possible',
  master: 'Act as NTP master clock',
  st: 'Stratum number',
  'snmp-server': 'Modify SNMP engine parameters',
  community: 'Enable SNMP; set community string and access privs',
  comm: 'SNMP community string',
  RO: 'Read-only access with this community string',
  RW: 'Read-write access with this community string',
  acl: 'Std IP accesslist allowed access',
  location: 'Text for mib object sysLocation',
  contact: 'Text for mib object sysContact',
  text: 'identification string',
  group: 'Define a User Security Model group',
  user: 'Define a user who can access the SNMP engine',
  g: 'Name of the group',
  u: 'Name of the user',
  v3: 'group using the User Security Model (SNMPv3)',
  auth: 'group using the authNoPriv Security Level',
  priv: 'group using SNMPv3 authPriv security level',
  noauth: 'group using the noAuthNoPriv Security Level',
  rest: 'auth sha|md5 PASSWORD priv aes 128|des PASSWORD',
  no: 'Negate a command or set its defaults',
  show: 'Show running system information',
  status: 'NTP status',
  associations: 'NTP associations',
  snmp: 'snmp statistics',
  clock: 'Manage the system clock',
  set: 'Set the time and date',
  when: 'hh:mm:ss day month year',
};

const logging = (c: Ctx): LoggingConfig => (c.dev.running.logging ??= structuredClone(DEFAULT_LOGGING));
const snmp = (c: Ctx): SnmpConfig => (c.dev.running.snmp ??= { communities: {}, location: null, contact: null, groups: {}, users: {} });
const ntp = (c: Ctx): NtpConfig => (c.dev.running.ntp ??= { servers: [], master: null });

function level(c: Ctx, a: Args, key = 'level'): number | null {
  const n = parseSeverity(String(a[key]));
  if (n === null) caret(c, a[`@${key}`] as number);
  return n;
}

export function addMgmtGlobal(t: Tree): void {
  // ---- syslog
  const addHost = (c: Ctx, a: Args) => {
    const ip = parseIp(a.addr as string)!;
    const l = logging(c);
    if (!l.hosts.includes(ip)) l.hosts.push(ip);
  };
  const delHost = (c: Ctx, a: Args) => {
    const ip = parseIp(a.addr as string)!;
    logging(c).hosts = logging(c).hosts.filter((h) => h !== ip);
  };
  t.add('logging host <ip:addr>', HM, addHost);
  t.add('logging <ip:addr>', HM, addHost);
  t.add('no logging host <ip:addr>', HM, delHost);
  t.add('no logging <ip:addr>', HM, delHost);
  t.add('logging trap <word:level>', HM, (c, a) => {
    const n = level(c, a);
    if (n !== null) logging(c).trap = n;
  });
  t.add('no logging trap', HM, (c) => void (logging(c).trap = 6));
  t.add('logging buffered', HM, (c) => void (logging(c).buffered ??= { size: 8192, level: 7 }));
  t.add('logging buffered <word:arg>', HM, (c, a) => {
    const text = String(a.arg);
    const b = (logging(c).buffered ??= { size: 8192, level: 7 });
    if (/^\d+$/.test(text) && Number(text) > 7) {
      if (Number(text) < 4096) return caret(c, a['@arg'] as number);
      b.size = Number(text);
      return;
    }
    const n = level(c, a, 'arg');
    if (n !== null) b.level = n;
  });
  t.add('logging buffered <number:size:4096-2147483647> <word:level>', HM, (c, a) => {
    const n = level(c, a);
    if (n !== null) logging(c).buffered = { size: a.size as number, level: n };
  });
  t.add('no logging buffered', HM, (c) => void (logging(c).buffered = null));
  t.add('logging console', HM, (c) => void (logging(c).console = 7));
  t.add('logging console <word:level>', HM, (c, a) => {
    const n = level(c, a);
    if (n !== null) logging(c).console = n;
  });
  t.add('no logging console', HM, (c) => void (logging(c).console = null));
  t.add('logging monitor <word:level>', HM, (c, a) => {
    const n = level(c, a);
    if (n !== null) logging(c).monitor = n;
  });

  // ---- timestamps
  t.add('service timestamps log datetime', HM, (c) => void (c.dev.running.timestamps = { ...DEFAULT_TIMESTAMPS, msec: false }));
  t.add('service timestamps log datetime <line:opts>', HM, (c, a) => {
    const words = String(a.opts).toLowerCase().split(/\s+/);
    const ok = ['msec', 'localtime', 'show-timezone', 'year'];
    const bad = words.findIndex((w) => !ok.some((o) => o.startsWith(w)));
    if (bad >= 0) return caret(c, (a['@opts'] as number) + String(a.opts).indexOf(String(a.opts).split(/\s+/)[bad]));
    const has = (o: string) => words.some((w) => o.startsWith(w));
    c.dev.running.timestamps = { mode: 'datetime', msec: has('msec'), localtime: has('localtime'), showTimezone: has('show-timezone') };
  });
  t.add('service timestamps log uptime', HM, (c) => void (c.dev.running.timestamps = { ...DEFAULT_TIMESTAMPS, mode: 'uptime' }));
  t.add('no service timestamps log', HM, (c) => void (c.dev.running.timestamps = { ...DEFAULT_TIMESTAMPS, mode: 'none' }));
  t.add('service timestamps debug <line:opts>', HM, () => {});

  // ---- NTP
  const server = (prefer: boolean) => (c: Ctx, a: Args) => {
    const ip = parseIp(a.addr as string)!;
    const n = ntp(c);
    n.servers = n.servers.filter((s) => s.ip !== ip);
    n.servers.push({ ip, prefer });
    commit(c);
  };
  t.add('ntp server <ip:addr>', HM, server(false));
  t.add('ntp server <ip:addr> prefer', HM, server(true));
  t.add('no ntp server <ip:addr>', HM, (c, a) => {
    const ip = parseIp(a.addr as string)!;
    ntp(c).servers = ntp(c).servers.filter((s) => s.ip !== ip);
    commit(c);
  });
  t.add('ntp master', HM, (c) => void (ntp(c).master = 8));
  t.add('ntp master <number:st:1-15>', HM, (c, a) => void (ntp(c).master = a.st as number));
  t.add('no ntp master', HM, (c) => void (ntp(c).master = null));

  // ---- SNMP
  const community = (access: 'RO' | 'RW') => (c: Ctx, a: Args) => {
    snmp(c).communities[String(a.comm)] = { access, ...(a.acl !== undefined ? { acl: String(a.acl) } : {}) };
  };
  t.add('snmp-server community <word:comm> RO', HM, community('RO'));
  t.add('snmp-server community <word:comm> RW', HM, community('RW'));
  t.add('snmp-server community <word:comm> RO <word:acl>', HM, community('RO'));
  t.add('snmp-server community <word:comm> RW <word:acl>', HM, community('RW'));
  t.add('no snmp-server community <word:comm>', HM, (c, a) => void delete snmp(c).communities[String(a.comm)]);
  t.add('snmp-server location <line:text>', HM, (c, a) => void (snmp(c).location = String(a.text)));
  t.add('snmp-server contact <line:text>', HM, (c, a) => void (snmp(c).contact = String(a.text)));
  t.add('no snmp-server location', HM, (c) => void (snmp(c).location = null));
  t.add('no snmp-server contact', HM, (c) => void (snmp(c).contact = null));
  for (const sec of ['auth', 'priv', 'noauth'] as const) {
    t.add(`snmp-server group <word:g> v3 ${sec}`, HM, (c, a) => void (snmp(c).groups[String(a.g)] = sec));
  }
  t.add('no snmp-server group <word:g> v3', HM, (c, a) => void delete snmp(c).groups[String(a.g)]);
  t.add('snmp-server user <word:u> <word:g> v3 <line:rest>', HM, (c, a) => {
    const w = String(a.rest).split(/\s+/);
    let auth: 'sha' | 'md5' | null = null;
    let priv: 'aes' | 'des' | null = null;
    for (let i = 0; i < w.length; i++) {
      if (w[i] === 'auth' && (w[i + 1] === 'sha' || w[i + 1] === 'md5') && w[i + 2]) auth = w[i + 1] as 'sha' | 'md5';
      if (w[i] === 'priv' && (w[i + 1] === 'aes' || w[i + 1] === 'des') && w[i + 2]) priv = w[i + 1] as 'aes' | 'des';
    }
    if (!auth) return caret(c, a['@rest'] as number);
    if (!snmp(c).groups[String(a.g)]) c.out.push(`% Group ${a.g} does not exist. Please configure the group first.`);
    snmp(c).users[String(a.u)] = { group: String(a.g), auth, priv };
  });
  t.add('no snmp-server user <word:u> <word:g> v3', HM, (c, a) => void delete snmp(c).users[String(a.u)]);
  t.add('no snmp-server', HM, (c) => void delete c.dev.running.snmp);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function addMgmtShows(t: Tree, privileged: boolean): void {
  t.add('show logging', HM, (c) => c.out.push(...showLogging(c.net, c.dev)));
  t.add('show ntp status', HM, (c) => c.out.push(...showNtpStatus(c.net, c.dev)));
  t.add('show ntp associations', HM, (c) => c.out.push(...showNtpAssociations(c.net, c.dev)));
  t.add('show snmp community', HM, (c) => {
    for (const name of Object.keys(c.dev.running.snmp?.communities ?? {})) {
      c.out.push('', `Community name: ${name}`, `Community Index: ${name}`, `Community SecurityName: ${name}`, 'storage-type: nonvolatile        active', '');
    }
  });
  t.add('show snmp user', HM, (c) => {
    for (const [name, u] of Object.entries(c.dev.running.snmp?.users ?? {})) {
      c.out.push(
        '',
        `User name: ${name}`,
        `Engine ID: 80000009030000${c.dev.baseMac.replace(/\./g, '').toUpperCase()}`,
        'storage-type: nonvolatile        active',
        `Authentication Protocol: ${u.auth ? u.auth.toUpperCase() : 'None'}`,
        `Privacy Protocol: ${u.priv === 'aes' ? 'AES128' : u.priv === 'des' ? 'DES' : 'None'}`,
        `Group-name: ${u.group}`,
      );
    }
  });
  t.add('show snmp', HM, (c) => {
    const s = c.dev.running.snmp;
    if (!s || !Object.keys(s.communities).length) return void c.out.push('%SNMP agent not enabled');
    const polls = Math.floor((c.net.time - c.dev.bootedAt) / 5000);
    c.out.push(
      `Chassis: ${c.dev.serial}`,
      ...(s.contact ? [`Contact: ${s.contact}`] : []),
      ...(s.location ? [`Location: ${s.location}`] : []),
      `${polls * 6} SNMP packets input`,
      '    0 Bad SNMP version errors',
      '    0 Unknown community name',
      '    0 Illegal operation for community name supplied',
      '    0 Encoding errors',
      `    ${polls * 24} Number of requested variables`,
      '    0 Number of altered variables',
      `    ${polls * 3} Get-request PDUs`,
      `    ${polls * 3} Get-next PDUs`,
      '    0 Set-request PDUs',
      '    0 Input queue packet drops (Maximum queue size 1000)',
      `${polls * 6} SNMP packets output`,
      '    0 Too big errors (Maximum packet size 1500)',
      '    0 No such name errors',
      '    0 Bad values errors',
      '    0 General errors',
      `    ${polls * 6} Response PDUs`,
      '    0 Trap PDUs',
      'SNMP logging: disabled',
    );
  });
  if (privileged) {
    t.add('clock set <line:when>', HM, (c, a) => {
      // hh:mm:ss day month year, or hh:mm:ss month day year
      const w = String(a.when).trim().split(/\s+/);
      const hms = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(w[0] ?? '');
      if (!hms || w.length !== 4) return void c.out.push('% Incomplete command.', '');
      const monthIdx = (x: string) => MONTHS.findIndex((m) => x.toLowerCase().startsWith(m));
      let day: number;
      let month: number;
      if (monthIdx(w[1]) >= 0) {
        month = monthIdx(w[1]);
        day = Number(w[2]);
      } else {
        day = Number(w[1]);
        month = monthIdx(w[2]);
      }
      const year = Number(w[3]);
      if (month < 0 || !(day >= 1 && day <= 31) || !(year >= 1993 && year <= 2035)) return caret(c, a['@when'] as number);
      const target = Date.UTC(year, month, day, Number(hms[1]), Number(hms[2]), Number(hms[3]));
      c.dev.clockOffset = target - c.net.wallClock().getTime();
      c.dev.clockSetAt = c.net.time;
    });
  }
}
