// NAT commands (routers): `ip nat inside|outside`, `ip nat pool`, `ip nat inside source list|static`,
// `show ip nat translations|statistics`, `clear ip nat translation *`.

import { formatIp, maskToPrefix, parseIp } from '../ip';
import { natStats, showNatStatistics, showNatTranslations, type NatConfig, type NatRule } from '../nat';
import { caret, commit, type Ctx, type Tree } from './context';
import type { Args } from './parser';

const HN: Record<string, string> = {
  ip: 'Global IP configuration subcommands',
  nat: 'NAT configuration commands',
  inside: 'Inside address translation',
  outside: 'Outside address translation',
  source: 'Source address translation',
  list: 'Specify access list describing local addresses',
  acl: 'Access list number or name for local addresses',
  interface: 'Specify interface for global address',
  if: 'Interface name',
  overload: 'Overload an address translation',
  pool: 'Name pool of global addresses',
  pname: 'Pool name',
  start: 'Start IP address',
  end: 'End IP address',
  netmask: 'Specify the network mask',
  mask: 'Network mask',
  'prefix-length': 'Specify the prefix length',
  len: 'Prefix length',
  static: 'Specify static local->global mapping',
  local: 'Inside local IP address',
  global: 'Inside global IP address',
  tcp: 'Transmission Control Protocol',
  udp: 'User Datagram Protocol',
  lport: 'Local UDP/TCP port',
  gport: 'Global UDP/TCP port',
  extendable: 'Extend this translation when used',
  no: 'Negate a command or set its defaults',
  translations: 'Translation entries',
  statistics: 'Translation statistics',
  translation: 'Clear dynamic translation',
  '*': 'Delete all dynamic translations',
  clear: 'Reset functions',
  show: 'Show running system information',
};

const nat = (c: Ctx): NatConfig => (c.dev.running.nat ??= { pools: {}, rules: [] });

function sameRule(a: NatRule, b: NatRule): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function addRule(c: Ctx, rule: NatRule): void {
  const cfg = nat(c);
  if (rule.kind === 'dynamic') {
    // One dynamic rule per ACL: a new one replaces the old (IOS asks; the sim just does it).
    cfg.rules = cfg.rules.filter((r) => !(r.kind === 'dynamic' && r.acl === rule.acl));
  } else if (cfg.rules.some((r) => r.kind === 'static' && r.local === rule.local && r.proto === rule.proto && r.localPort === rule.localPort)) {
    c.out.push(`% similar static entry (${formatIp(rule.local)} -> ${formatIp(rule.global)}) already exists`);
    return;
  }
  cfg.rules.push(rule);
  commit(c);
}

function removeRule(c: Ctx, rule: NatRule): void {
  const cfg = nat(c);
  const before = cfg.rules.length;
  cfg.rules = cfg.rules.filter((r) => !sameRule(r, rule));
  if (cfg.rules.length === before) c.out.push('%Translation not found');
  if (rule.kind === 'dynamic') c.dev.natTable = (c.dev.natTable ?? []).filter((e) => e.static);
  commit(c);
}

export function addNatGlobal(t: Tree): void {
  const ifc = (c: Ctx, a: Args): string | null => {
    const name = a.if as string;
    if (!c.dev.running.interfaces[name]) {
      caret(c, a['@if'] as number);
      return null;
    }
    return name;
  };
  const dyn = (via: 'iface' | 'pool', overload: boolean, remove = false) => (c: Ctx, a: Args) => {
    let rule: NatRule;
    if (via === 'iface') {
      const name = ifc(c, a);
      if (!name) return;
      rule = { kind: 'dynamic', acl: String(a.acl), iface: name, overload };
    } else {
      if (!remove && !nat(c).pools[String(a.pname)]) c.out.push(`%Pool ${a.pname} not found`);
      rule = { kind: 'dynamic', acl: String(a.acl), pool: String(a.pname), overload };
    }
    if (remove) removeRule(c, rule);
    else addRule(c, rule);
  };
  t.add('ip nat inside source list <word:acl> interface <iface:if> overload', HN, dyn('iface', true));
  t.add('ip nat inside source list <word:acl> interface <iface:if>', HN, dyn('iface', false));
  t.add('ip nat inside source list <word:acl> pool <word:pname> overload', HN, dyn('pool', true));
  t.add('ip nat inside source list <word:acl> pool <word:pname>', HN, dyn('pool', false));
  t.add('no ip nat inside source list <word:acl> interface <iface:if> overload', HN, dyn('iface', true, true));
  t.add('no ip nat inside source list <word:acl> interface <iface:if>', HN, dyn('iface', false, true));
  t.add('no ip nat inside source list <word:acl> pool <word:pname> overload', HN, dyn('pool', true, true));
  t.add('no ip nat inside source list <word:acl> pool <word:pname>', HN, dyn('pool', false, true));

  const one = (remove: boolean) => (c: Ctx, a: Args) => {
    const rule: NatRule = { kind: 'static', local: parseIp(a.local as string)!, global: parseIp(a.global as string)! };
    if (remove) removeRule(c, rule);
    else addRule(c, rule);
  };
  t.add('ip nat inside source static <ip:local> <ip:global>', HN, one(false));
  t.add('no ip nat inside source static <ip:local> <ip:global>', HN, one(true));
  for (const proto of ['tcp', 'udp'] as const) {
    const port = (remove: boolean, viaIf: boolean, extendable: boolean) => (c: Ctx, a: Args) => {
      let globalIface: string | undefined;
      if (viaIf) {
        const name = ifc(c, a);
        if (!name) return;
        globalIface = name;
      }
      const rule: NatRule = {
        kind: 'static',
        local: parseIp(a.local as string)!,
        global: viaIf ? 0 : parseIp(a.global as string)!,
        proto,
        localPort: a.lport as number,
        globalPort: a.gport as number,
        ...(globalIface ? { globalIface } : {}),
        ...(extendable ? { extendable: true } : {}),
      };
      if (remove) removeRule(c, rule);
      else addRule(c, rule);
    };
    const base = `ip nat inside source static ${proto} <ip:local> <number:lport:1-65535>`;
    t.add(`${base} <ip:global> <number:gport:1-65535>`, HN, port(false, false, false));
    t.add(`${base} <ip:global> <number:gport:1-65535> extendable`, HN, port(false, false, true));
    t.add(`${base} interface <iface:if> <number:gport:1-65535>`, HN, port(false, true, false));
    t.add(`no ${base} <ip:global> <number:gport:1-65535>`, HN, port(true, false, false));
    t.add(`no ${base} <ip:global> <number:gport:1-65535> extendable`, HN, port(true, false, true));
    t.add(`no ${base} interface <iface:if> <number:gport:1-65535>`, HN, port(true, true, false));
  }

  const pool = (byPrefix: boolean) => (c: Ctx, a: Args) => {
    const start = parseIp(a.start as string)!;
    const end = parseIp(a.end as string)!;
    const prefix = byPrefix ? (a.len as number) : maskToPrefix(parseIp(a.mask as string)!);
    if (prefix === null) return void c.out.push('%Invalid netmask');
    if (end < start) return void c.out.push('%End address less than starting address');
    const net = (x: number) => (x & ((0xffffffff << (32 - prefix)) >>> 0)) >>> 0;
    if (net(start) !== net(end)) return void c.out.push('%Start and end addresses on different subnets');
    nat(c).pools[String(a.pname)] = { start, end, prefix };
    commit(c);
  };
  t.add('ip nat pool <word:pname> <ip:start> <ip:end> netmask <mask:mask>', HN, pool(false));
  t.add('ip nat pool <word:pname> <ip:start> <ip:end> prefix-length <number:len:1-32>', HN, pool(true));
  t.add('no ip nat pool <word:pname>', HN, (c, a) => {
    const name = String(a.pname);
    if (nat(c).rules.some((r) => r.kind === 'dynamic' && r.pool === name)) return void c.out.push(`%Pool ${name} in use, cannot destroy`);
    delete nat(c).pools[name];
    commit(c);
  });
}

export function addNatInterface(t: Tree): void {
  const set = (role: 'inside' | 'outside' | null) => (c: Ctx) => {
    for (const name of c.s.ifContext) {
      const ifc = c.dev.running.interfaces[name];
      if (!ifc) continue;
      if (role) ifc.nat = role;
      else delete ifc.nat;
    }
    commit(c);
  };
  t.add('ip nat inside', HN, set('inside'));
  t.add('ip nat outside', HN, set('outside'));
  t.add('no ip nat inside', HN, set(null));
  t.add('no ip nat outside', HN, set(null));
}

function ago(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function addNatShows(t: Tree, privileged: boolean): void {
  t.add('show ip nat translations', HN, (c) => c.out.push(...showNatTranslations(c.net, c.dev)));
  t.add('show ip nat statistics', HN, (c) => c.out.push(...showNatStatistics(c.net, c.dev, ago)));
  if (privileged) {
    t.add('clear ip nat translation *', HN, (c) => {
      c.dev.natTable = [];
    });
    t.add('clear ip nat statistics', HN, (c) => {
      const s = natStats(c.dev);
      s.hits = 0;
      s.misses = 0;
      s.expired = 0;
    });
  }
}
