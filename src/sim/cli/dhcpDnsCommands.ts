// IOS DHCP server commands (`ip dhcp pool` and its sub-mode, `ip dhcp excluded-address`, `service dhcp`,
// show/clear) and IOS DNS commands (`ip name-server`, `ip host`, `show hosts`).

import { formatIp, maskToPrefix, networkOf, parseIp, type Ipv4 } from '../ip';
import { DAY_MS, newPool, showDhcpBinding, showDhcpConflict, showDhcpPool, type IosDhcpPool } from '../iosDhcp';
import { caret, commit, type Ctx, type Tree } from './context';
import type { Args } from './parser';

const HD: Record<string, string> = {
  ip: 'Global IP configuration subcommands',
  dhcp: 'Configure DHCP server and relay parameters',
  pool: 'Configure DHCP address pools',
  name: 'Pool name',
  'excluded-address': 'Prevent DHCP from assigning certain addresses',
  low: 'Low IP address',
  high: 'High IP address',
  service: 'Modify use of network based services',
  network: 'Network number and mask',
  net: 'Network number in dotted-decimal notation',
  mask: 'Network mask or prefix length',
  'default-router': 'Default routers',
  ips: 'Router\'s IP address',
  'dns-server': 'DNS servers',
  'domain-name': 'Domain name',
  dname: 'Domain name',
  lease: 'Address lease time',
  days: 'Days',
  hours: 'Hours',
  mins: 'Minutes',
  infinite: 'Infinite lease',
  binding: 'DHCP address bindings',
  conflict: 'DHCP address conflicts',
  '*': 'Clear all',
  'name-server': 'Specify address of name server to use',
  servers: 'Domain server IP address (maximum of 6)',
  host: 'Add an entry to the ip hostname table',
  hname: 'Name of host',
  addr: 'Host IP address',
  hosts: 'IP domain-name, lookup style, nameservers, and host table',
  no: 'Negate a command or set its defaults',
  show: 'Show running system information',
  clear: 'Reset functions',
  all: 'Delete all host table entries',
};

/** Parses "10.1.1.1 10.1.1.2" (up to `max`) with a caret on the first bad one. */
function ipList(c: Ctx, a: Args, key: string, max: number): Ipv4[] | null {
  const text = a[key] as string;
  const at = a[`@${key}`] as number;
  const out: Ipv4[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const ip = parseIp(m[0]);
    if (ip === null || out.length >= max) {
      caret(c, at + m.index);
      return null;
    }
    out.push(ip);
  }
  return out;
}

export function addDhcpDnsGlobal(t: Tree): void {
  t.add('ip dhcp pool <word:name>', HD, (c, a) => {
    const pools = (c.dev.running.dhcpPools ??= {});
    pools[String(a.name)] ??= newPool();
    commit(c);
    c.s.enterDhcpPool(String(a.name));
  });
  t.add('no ip dhcp pool <word:name>', HD, (c, a) => {
    const name = String(a.name);
    if (!c.dev.running.dhcpPools?.[name]) return void c.out.push(`%Pool ${name} not found`);
    delete c.dev.running.dhcpPools[name];
    delete c.dev.dhcpBindings?.[name];
    commit(c);
  });
  const excl = (remove: boolean) => (c: Ctx, a: Args) => {
    const lo = parseIp(a.low as string)!;
    const hi = a.high !== undefined ? parseIp(a.high as string)! : lo;
    if (hi < lo) return void c.out.push('%Invalid address range');
    const list = (c.dev.running.dhcpExcluded ??= []);
    if (remove) {
      const i = list.findIndex(([x, y]) => x === lo && y === hi);
      if (i < 0) return void c.out.push('%Range not found');
      list.splice(i, 1);
    } else if (!list.some(([x, y]) => x === lo && y === hi)) {
      list.push([lo, hi]);
      list.sort((x, y) => x[0] - y[0]);
    }
    commit(c);
  };
  t.add('ip dhcp excluded-address <ip:low>', HD, excl(false));
  t.add('ip dhcp excluded-address <ip:low> <ip:high>', HD, excl(false));
  t.add('no ip dhcp excluded-address <ip:low>', HD, excl(true));
  t.add('no ip dhcp excluded-address <ip:low> <ip:high>', HD, excl(true));
  t.add('service dhcp', HD, (c) => {
    delete c.dev.running.serviceDhcp;
    commit(c);
  });
  t.add('no service dhcp', HD, (c) => {
    c.dev.running.serviceDhcp = false;
    commit(c);
  });

  // DNS
  t.add('ip name-server <line:servers>', HD, (c, a) => {
    const list = ipList(c, a, 'servers', 6);
    if (!list) return;
    const cur = (c.dev.running.nameServers ??= []);
    for (const ip of list) if (!cur.includes(ip) && cur.length < 6) cur.push(ip);
  });
  t.add('no ip name-server', HD, (c) => void (c.dev.running.nameServers = []));
  t.add('no ip name-server <line:servers>', HD, (c, a) => {
    const list = ipList(c, a, 'servers', 6);
    if (!list) return;
    c.dev.running.nameServers = (c.dev.running.nameServers ?? []).filter((x) => !list.includes(x));
  });
  t.add('ip host <word:hname> <ip:addr>', HD, (c, a) => {
    const name = String(a.hname);
    if (!/^[A-Za-z][A-Za-z0-9.-]*$/.test(name)) return caret(c, a['@hname'] as number);
    (c.dev.running.hosts ??= {})[name] = parseIp(a.addr as string)!;
  });
  t.add('no ip host <word:hname>', HD, (c, a) => {
    if (c.dev.running.hosts) delete c.dev.running.hosts[String(a.hname)];
  });
}

/** The `(dhcp-config)#` sub-mode. */
export function addDhcpPoolMode(t: Tree): void {
  const pool = (c: Ctx): IosDhcpPool => c.dev.running.dhcpPools![c.s.dhcpContext!];
  t.add('network <ip:net> <word:mask>', HD, (c, a) => {
    const m = String(a.mask);
    const prefix = m.startsWith('/') ? Number(m.slice(1)) : maskToPrefix(parseIp(m) ?? -1);
    if (prefix === null || !Number.isInteger(prefix) || prefix < 1 || prefix > 30) return caret(c, a['@mask'] as number);
    const p = pool(c);
    p.network = networkOf(parseIp(a.net as string)!, prefix);
    p.prefix = prefix;
    commit(c);
  });
  t.add('no network', HD, (c) => {
    const p = pool(c);
    p.network = null;
    p.prefix = null;
    commit(c);
  });
  t.add('default-router <line:ips>', HD, (c, a) => {
    const list = ipList(c, a, 'ips', 8);
    if (list) pool(c).defaultRouter = list;
  });
  t.add('no default-router', HD, (c) => void (pool(c).defaultRouter = []));
  t.add('dns-server <line:ips>', HD, (c, a) => {
    const list = ipList(c, a, 'ips', 8);
    if (list) pool(c).dnsServer = list;
  });
  t.add('no dns-server', HD, (c) => void (pool(c).dnsServer = []));
  t.add('domain-name <word:dname>', HD, (c, a) => void (pool(c).domainName = String(a.dname)));
  t.add('no domain-name', HD, (c) => void (pool(c).domainName = null));
  const lease = (c: Ctx, a: Args) => {
    const ms = (a.days as number) * DAY_MS + ((a.hours as number | undefined) ?? 0) * 3600_000 + ((a.mins as number | undefined) ?? 0) * 60_000;
    if (ms === 0) return void c.out.push('% A lease time of 0 is not allowed');
    pool(c).leaseMs = ms;
  };
  t.add('lease <number:days:0-365>', HD, lease);
  t.add('lease <number:days:0-365> <number:hours:0-23>', HD, lease);
  t.add('lease <number:days:0-365> <number:hours:0-23> <number:mins:0-59>', HD, lease);
  t.add('lease infinite', HD, (c) => void (pool(c).leaseMs = null));
  t.add('no lease', HD, (c) => void (pool(c).leaseMs = DAY_MS));
}

export function addDhcpDnsShows(t: Tree, privileged: boolean, dhcpServer: boolean): void {
  if (dhcpServer) {
    t.add('show ip dhcp binding', HD, (c) => c.out.push(...showDhcpBinding(c.net, c.dev)));
    t.add('show ip dhcp pool', HD, (c) => c.out.push(...showDhcpPool(c.dev)));
    t.add('show ip dhcp pool <word:name>', HD, (c, a) => c.out.push(...showDhcpPool(c.dev, String(a.name))));
    t.add('show ip dhcp conflict', HD, (c) => c.out.push(...showDhcpConflict(c.net, c.dev)));
    if (privileged) {
      t.add('clear ip dhcp binding *', HD, (c) => void (c.dev.dhcpBindings = {}));
      t.add('clear ip dhcp conflict *', HD, (c) => void (c.dev.dhcpConflicts = []));
    }
  }
  t.add('show hosts', HD, (c) => {
    const cfg = c.dev.running;
    const servers = cfg.nameServers ?? [];
    c.out.push(
      'Name lookup view: Global',
      `Default domain is ${cfg.domainName ?? 'not set'}`,
      `Name/address lookup uses ${cfg.domainLookup ? 'domain service' : 'static mappings'}`,
      `Name servers are ${servers.length ? servers.map(formatIp).join(', ') : '255.255.255.255'}`,
      '',
      'Codes: UN - unknown, EX - expired, OK - OK, ?? - revalidate',
      '       temp - temporary, perm - permanent',
      '       NA - Not Applicable None - Not defined',
      '',
      'Host                      Port  Flags      Age Type   Address(es)',
    );
    for (const [n, ip] of Object.entries(cfg.hosts ?? {})) c.out.push(`${n.padEnd(26)}None  (perm, OK)  0   IP    ${formatIp(ip)}`);
    for (const [n, e] of Object.entries(c.dev.hostCache ?? {})) {
      const age = Math.floor((c.net.time - e.at) / 3600_000);
      c.out.push(`${n.padEnd(26)}None  (temp, OK)  ${String(age).padEnd(4)}IP    ${formatIp(e.ip)}`);
    }
  });
  if (privileged) {
    t.add('clear host all', HD, (c) => void (c.dev.hostCache = {}));
    t.add('clear host *', HD, (c) => void (c.dev.hostCache = {}));
  }
}
