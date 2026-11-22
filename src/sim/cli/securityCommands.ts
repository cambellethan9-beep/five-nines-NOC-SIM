// Security commands: time ranges, MAC ACLs, VLAN access maps and `vlan filter`, ARP ACLs, DHCP snooping, dynamic ARP
// inspection, IP source guard, static source bindings and the relay's option 82 trust, plus their show commands.

import { DAY_WORDS, parseAbsolute, type TimeRange } from '../acl';
import { shortIfName } from '../ifnames';
import { formatIp, parseIp } from '../ip';
import { formatVlanList, parseVlanList } from '../render';
import {
  showArpInspection,
  showArpInspectionInterfaces,
  showSnoopBindings,
  showSnooping,
  showSourceBindings,
  showVerifySource,
} from '../security';
import type { ArpAclEntry, DeviceConfig, DeviceKind, MacAclEntry } from '../types';
import { isSwitchKind } from '../types';
import { caret, commit, type Ctx, type Tree } from './context';
import type { Args } from './parser';

const H: Record<string, string> = {
  'time-range': 'Define time range entries',
  name: 'Name',
  periodic: 'Periodic time and date',
  absolute: 'Absolute time and date',
  spec: 'Days and times, e.g. "weekdays 8:00 to 17:00"',
  mac: 'MAC configuration subcommands',
  'access-list': 'Named access-list',
  extended: 'Extended Access List',
  'access-group': 'MAC access-group',
  in: 'Apply to incoming packets',
  vlan: 'VLAN commands',
  'access-map': 'Create vlan access-map or enter vlan access-map command mode',
  seq: 'Sequence to insert to/delete from existing vlan access-map entry',
  filter: 'Apply a VLAN Map',
  'vlan-list': 'VLANs to apply filter to',
  list: 'VLAN id list (e.g. 10,20-30)',
  arp: 'Configure ARP',
  ip: 'Global IP configuration subcommands',
  dhcp: 'Configure DHCP server and relay parameters',
  snooping: 'DHCP Snooping',
  information: 'DHCP Snooping information',
  option: 'DHCP Snooping information option',
  trust: 'DHCP Snooping trust config',
  limit: 'DHCP Snooping limit',
  rate: 'DHCP Snooping limit rate',
  pps: 'DHCP snooping rate limit (packets per second)',
  inspection: 'Arp Inspection configuration',
  validate: 'Validate addresses',
  what: 'src-mac | dst-mac | ip',
  acl: 'ARP ACL name',
  static: 'Apply the ACL statically',
  source: 'Configure source',
  binding: 'Configure static ip source bindings',
  addr: 'IP address',
  hw: 'Binding MAC address (H.H.H)',
  id: 'VLAN id',
  interface: 'Binding interface',
  if: 'Interface name',
  verify: 'verify',
  relay: 'DHCP relay agent parameters',
  'trust-all': 'Received DHCP packets may contain relay info option with zero giaddr',
  trusted: 'Received DHCP packet may contain relay info option with zero giaddr',
  none: 'No limit',
  no: 'Negate a command or set its defaults',
  show: 'Show running system information',
  clear: 'Reset functions',
  statistics: 'Statistics',
  interfaces: 'Arp Inspection interfaces',
  all: 'All bindings',
};

const MAC_RE = /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const cfg = (c: Ctx): DeviceConfig => c.dev.running;
const sub = (c: Ctx) => c.s.subContext!;

function vlans(c: Ctx, a: Args, key = 'list'): number[] | null {
  const v = parseVlanList(String(a[key]));
  if (!v) caret(c, a[`@${key}`] as number);
  return v;
}

// ---- time-range -------------------------------------------------------------------------------

/** "weekdays 8:00 to 17:00", "Monday Wednesday 9:00 to 12:00", "Friday 22:00 to Monday 6:00". */
function parsePeriodic(text: string): TimeRange['periodic'][number] | null {
  const ts = text.trim().split(/\s+/);
  const days: string[] = [];
  let i = 0;
  const day = (w: string | undefined) => (w ? DAY_WORDS.find((d) => d.toLowerCase() === w.toLowerCase() || (w.length >= 3 && d.toLowerCase().startsWith(w.toLowerCase()))) : undefined);
  while (day(ts[i])) days.push(cap(day(ts[i++])!));
  if (!days.length || !TIME_RE.test(ts[i] ?? '') || ts[i + 1]?.toLowerCase() !== 'to') return null;
  const from = norm(ts[i]);
  i += 2;
  let toDay: string | undefined;
  if (day(ts[i])) toDay = cap(day(ts[i++])!);
  if (!TIME_RE.test(ts[i] ?? '') || ts[i + 1]) return null;
  if (toDay && (days.length !== 1 || ['Daily', 'Weekdays', 'Weekend'].includes(days[0]))) return null;
  return { days: days.map((d) => (['Daily', 'Weekdays', 'Weekend'].includes(d) ? d.toLowerCase() : d)), from, to: norm(ts[i]), ...(toDay ? { toDay } : {}) };
}

function cap(w: string): string {
  return w[0].toUpperCase() + w.slice(1).toLowerCase();
}

function norm(t: string): string {
  const [h, m] = t.split(':');
  return `${Number(h)}:${m}`;
}

export function timeRangeLines(r: TimeRange): string[] {
  const out: string[] = [];
  if (r.absolute) out.push(` absolute${r.absolute.start ? ` start ${r.absolute.start}` : ''}${r.absolute.end ? ` end ${r.absolute.end}` : ''}`);
  for (const p of r.periodic) out.push(` periodic ${p.days.join(' ')} ${p.from} to ${p.toDay ? `${p.toDay} ` : ''}${p.to}`);
  return out;
}

export function addTimeRangeMode(t: Tree): void {
  const range = (c: Ctx) => (cfg(c).timeRanges ??= {})[sub(c).name];
  t.add('periodic <line:spec>', H, (c, a) => {
    const p = parsePeriodic(String(a.spec));
    if (!p) return caret(c, a['@spec'] as number);
    const r = range(c);
    if (!r.periodic.some((x) => JSON.stringify(x) === JSON.stringify(p))) r.periodic.push(p);
    commit(c);
  });
  t.add('no periodic <line:spec>', H, (c, a) => {
    const p = parsePeriodic(String(a.spec));
    const r = range(c);
    r.periodic = r.periodic.filter((x) => JSON.stringify(x) !== JSON.stringify(p));
    commit(c);
  });
  t.add('absolute <line:spec>', H, (c, a) => {
    const m = /^(?:start\s+(.+?))?\s*(?:end\s+(.+))?$/i.exec(String(a.spec).trim());
    const start = m?.[1]?.trim() ?? null;
    const end = m?.[2]?.trim() ?? null;
    if (!m || (!start && !end) || (start && parseAbsolute(start) === null) || (end && parseAbsolute(end) === null)) return caret(c, a['@spec'] as number);
    range(c).absolute = { start, end };
    commit(c);
  });
  t.add('no absolute', H, (c) => {
    range(c).absolute = null;
    commit(c);
  });
}

// ---- MAC ACLs ---------------------------------------------------------------------------------

function readMacSpec(ts: string[], i: number): { spec: MacAclEntry['src']; next: number } | null {
  const w = ts[i]?.toLowerCase();
  if (w === 'any') return { spec: null, next: i + 1 };
  if (w === 'host' && MAC_RE.test(ts[i + 1] ?? '')) return { spec: { mac: ts[i + 1].toLowerCase(), mask: '0000.0000.0000' }, next: i + 2 };
  if (MAC_RE.test(ts[i] ?? '') && MAC_RE.test(ts[i + 1] ?? '')) return { spec: { mac: ts[i].toLowerCase(), mask: ts[i + 1].toLowerCase() }, next: i + 2 };
  return null;
}

function parseMacEntry(text: string): MacAclEntry | null {
  const ts = text.trim().split(/\s+/);
  const action = ts[0]?.toLowerCase();
  if (action !== 'permit' && action !== 'deny') return null;
  const s = readMacSpec(ts, 1);
  if (!s) return null;
  const d = readMacSpec(ts, s.next);
  if (!d) return null;
  // An ethertype or protocol keyword may follow (e.g. "0x806 0x0" or "lsap"); it's kept loosely by ignoring it.
  return { action, src: s.spec, dst: d.spec };
}

export function macEntryText(e: MacAclEntry): string {
  const spec = (x: MacAclEntry['src']) => (x === null ? 'any' : x.mask === '0000.0000.0000' ? `host ${x.mac}` : `${x.mac} ${x.mask}`);
  return `${e.action} ${spec(e.src)} ${spec(e.dst)}`;
}

export function addMacAclMode(t: Tree): void {
  const acl = (c: Ctx) => (cfg(c).macAcls ??= {})[sub(c).name];
  for (const action of ['permit', 'deny']) {
    t.add(`${action} <line:rest>`, H, (c, a) => {
      const e = parseMacEntry(`${action} ${a.rest}`);
      if (!e) return caret(c, a['@rest'] as number);
      acl(c).entries.push(e);
      commit(c);
    });
    t.add(`no ${action} <line:rest>`, H, (c, a) => {
      const e = parseMacEntry(`${action} ${a.rest}`);
      acl(c).entries = acl(c).entries.filter((x) => JSON.stringify(x) !== JSON.stringify(e));
      commit(c);
    });
  }
}

// ---- VLAN access maps -------------------------------------------------------------------------

export function addVaclMode(t: Tree): void {
  const entry = (c: Ctx) => cfg(c).vlanMaps![sub(c).name].find((e) => e.seq === sub(c).seq)!;
  t.add('match ip address <line:names>', { ...H, match: 'Match values from packet', address: 'Match address of packet', names: 'IP access list name or number (one or more)' }, (c, a) => {
    const e = entry(c);
    for (const n of String(a.names).split(/\s+/)) if (!e.matchIp.includes(n)) e.matchIp.push(n);
    commit(c);
  });
  t.add('match mac address <word:names>', { ...H, match: 'Match values from packet', address: 'Match address of packet' }, (c, a) => {
    const e = entry(c);
    if (!e.matchMac.includes(String(a.names))) e.matchMac.push(String(a.names));
    commit(c);
  });
  t.add('no match ip address <line:names>', H, (c, a) => {
    const e = entry(c);
    const drop = String(a.names).split(/\s+/);
    e.matchIp = e.matchIp.filter((n) => !drop.includes(n));
    commit(c);
  });
  t.add('no match mac address <word:names>', H, (c, a) => {
    const e = entry(c);
    e.matchMac = e.matchMac.filter((n) => n !== a.names);
    commit(c);
  });
  t.add('action forward', { ...H, action: 'Take the action', forward: 'Forward the packets' }, (c) => {
    entry(c).action = 'forward';
    commit(c);
  });
  t.add('action drop', { ...H, action: 'Take the action', drop: 'Drop packets' }, (c) => {
    entry(c).action = 'drop';
    commit(c);
  });
}

// ---- ARP ACLs ---------------------------------------------------------------------------------

function parseArpEntry(text: string): ArpAclEntry | null {
  const m = /^(permit|deny)\s+ip\s+(any|host\s+\S+)\s+mac\s+(any|host\s+\S+)(\s+log)?$/i.exec(text.trim());
  if (!m) return null;
  const ip = m[2].toLowerCase() === 'any' ? null : parseIp(m[2].split(/\s+/)[1]);
  const macWord = m[3].toLowerCase() === 'any' ? null : m[3].split(/\s+/)[1].toLowerCase();
  if ((m[2].toLowerCase() !== 'any' && ip === null) || (macWord !== null && !MAC_RE.test(macWord))) return null;
  return { action: m[1].toLowerCase() as 'permit' | 'deny', ip, mac: macWord };
}

export function arpEntryText(e: ArpAclEntry): string {
  return `${e.action} ip ${e.ip === null ? 'any' : `host ${formatIp(e.ip)}`} mac ${e.mac === null ? 'any' : `host ${e.mac}`}`;
}

export function addArpAclMode(t: Tree): void {
  const list = (c: Ctx) => ((cfg(c).arpAcls ??= {})[sub(c).name] ??= []);
  for (const action of ['permit', 'deny']) {
    t.add(`${action} <line:rest>`, H, (c, a) => {
      const e = parseArpEntry(`${action} ${a.rest}`);
      if (!e) return caret(c, a['@rest'] as number);
      list(c).push(e);
      commit(c);
    });
    t.add(`no ${action} <line:rest>`, H, (c, a) => {
      const e = parseArpEntry(`${action} ${a.rest}`);
      (cfg(c).arpAcls ??= {})[sub(c).name] = list(c).filter((x) => JSON.stringify(x) !== JSON.stringify(e));
      commit(c);
    });
  }
}

// ---- global -----------------------------------------------------------------------------------

export function addSecurityGlobal(t: Tree, kind: DeviceKind): void {
  t.add('time-range <word:name>', H, (c, a) => {
    (cfg(c).timeRanges ??= {})[String(a.name)] ??= { periodic: [], absolute: null };
    c.s.enterSub('timerange', String(a.name));
  });
  t.add('no time-range <word:name>', H, (c, a) => {
    delete (cfg(c).timeRanges ??= {})[String(a.name)];
    commit(c);
  });
  if (kind === 'router' || kind === 'l3switch') {
    t.add('ip dhcp relay information trust-all', H, (c) => void (cfg(c).relayTrustAll = true));
    t.add('no ip dhcp relay information trust-all', H, (c) => void (cfg(c).relayTrustAll = false));
  }
  if (!isSwitchKind(kind)) return;
  t.add('mac access-list extended <word:name>', H, (c, a) => {
    (cfg(c).macAcls ??= {})[String(a.name)] ??= { name: String(a.name), entries: [] };
    c.s.enterSub('macl', String(a.name));
  });
  t.add('no mac access-list extended <word:name>', H, (c, a) => {
    delete (cfg(c).macAcls ??= {})[String(a.name)];
    commit(c);
  });
  const enterMap = (c: Ctx, name: string, seq: number) => {
    const maps = (cfg(c).vlanMaps ??= {});
    const list = (maps[name] ??= []);
    if (!list.some((e) => e.seq === seq)) {
      list.push({ seq, action: 'forward', matchIp: [], matchMac: [] });
      list.sort((x, y) => x.seq - y.seq);
    }
    c.s.enterSub('vacl', name, seq);
  };
  t.add('vlan access-map <word:name>', H, (c, a) => {
    const list = cfg(c).vlanMaps?.[String(a.name)] ?? [];
    // Without a sequence number IOS edits the map's first entry, or creates entry 10.
    enterMap(c, String(a.name), list.length ? list[0].seq : 10);
  });
  t.add('vlan access-map <word:name> <number:seq:0-65535>', H, (c, a) => enterMap(c, String(a.name), a.seq as number));
  t.add('no vlan access-map <word:name>', H, (c, a) => {
    delete (cfg(c).vlanMaps ??= {})[String(a.name)];
    commit(c);
  });
  t.add('no vlan access-map <word:name> <number:seq:0-65535>', H, (c, a) => {
    const maps = (cfg(c).vlanMaps ??= {});
    if (maps[String(a.name)]) maps[String(a.name)] = maps[String(a.name)].filter((e) => e.seq !== a.seq);
    commit(c);
  });
  t.add('vlan filter <word:name> vlan-list <word:list>', H, (c, a) => {
    const v = vlans(c, a);
    if (!v) return;
    const filters = (cfg(c).vlanFilters ??= []);
    // A VLAN takes one filter: applying another replaces it.
    for (const f of filters) f.vlans = f.vlans.filter((x) => !v.includes(x));
    const mine = filters.find((f) => f.map === a.name);
    if (mine) mine.vlans = [...new Set([...mine.vlans, ...v])].sort((x, y) => x - y);
    else filters.push({ map: String(a.name), vlans: v });
    cfg(c).vlanFilters = filters.filter((f) => f.vlans.length);
    commit(c);
  });
  t.add('no vlan filter <word:name> vlan-list <word:list>', H, (c, a) => {
    const v = vlans(c, a);
    if (!v) return;
    for (const f of cfg(c).vlanFilters ?? []) if (f.map === a.name) f.vlans = f.vlans.filter((x) => !v.includes(x));
    cfg(c).vlanFilters = (cfg(c).vlanFilters ?? []).filter((f) => f.vlans.length);
    commit(c);
  });
  t.add('arp access-list <word:name>', H, (c, a) => {
    (cfg(c).arpAcls ??= {})[String(a.name)] ??= [];
    c.s.enterSub('arpacl', String(a.name));
  });
  t.add('no arp access-list <word:name>', H, (c, a) => {
    delete (cfg(c).arpAcls ??= {})[String(a.name)];
    commit(c);
  });
  // DHCP snooping
  const snoop = (c: Ctx) => (cfg(c).snooping ??= { enabled: false, vlans: [], option82: true });
  t.add('ip dhcp snooping', H, (c) => {
    snoop(c).enabled = true;
    commit(c);
  });
  t.add('no ip dhcp snooping', H, (c) => {
    snoop(c).enabled = false;
    commit(c);
  });
  t.add('ip dhcp snooping vlan <word:list>', H, (c, a) => {
    const v = vlans(c, a);
    if (!v) return;
    snoop(c).vlans = [...new Set([...snoop(c).vlans, ...v])].sort((x, y) => x - y);
    commit(c);
  });
  t.add('no ip dhcp snooping vlan <word:list>', H, (c, a) => {
    const v = vlans(c, a);
    if (!v) return;
    snoop(c).vlans = snoop(c).vlans.filter((x) => !v.includes(x));
    commit(c);
  });
  t.add('ip dhcp snooping information option', H, (c) => void (snoop(c).option82 = true));
  t.add('no ip dhcp snooping information option', H, (c) => void (snoop(c).option82 = false));
  // Dynamic ARP inspection
  const dai = (c: Ctx) => (cfg(c).dai ??= { vlans: [], filters: [], validate: [] });
  t.add('ip arp inspection vlan <word:list>', H, (c, a) => {
    const v = vlans(c, a);
    if (!v) return;
    dai(c).vlans = [...new Set([...dai(c).vlans, ...v])].sort((x, y) => x - y);
    commit(c);
  });
  t.add('no ip arp inspection vlan <word:list>', H, (c, a) => {
    const v = vlans(c, a);
    if (!v) return;
    dai(c).vlans = dai(c).vlans.filter((x) => !v.includes(x));
    commit(c);
  });
  t.add('ip arp inspection validate <line:what>', H, (c, a) => {
    const words = String(a.what).toLowerCase().split(/\s+/);
    const ok = ['src-mac', 'dst-mac', 'ip'];
    const bad = words.find((w) => !ok.includes(w));
    if (bad) return caret(c, (a['@what'] as number) + String(a.what).toLowerCase().indexOf(bad));
    dai(c).validate = ok.filter((w) => words.includes(w)) as ('src-mac' | 'dst-mac' | 'ip')[];
  });
  t.add('no ip arp inspection validate', H, (c) => void (dai(c).validate = []));
  const setFilter = (isStatic: boolean) => (c: Ctx, a: Args) => {
    const v = vlans(c, a);
    if (!v) return;
    const d = dai(c);
    d.filters = d.filters.map((f) => ({ ...f, vlans: f.vlans.filter((x) => !v.includes(x)) })).filter((f) => f.vlans.length);
    d.filters.push({ acl: String(a.acl), vlans: v, static: isStatic });
    commit(c);
  };
  t.add('ip arp inspection filter <word:acl> vlan <word:list>', H, setFilter(false));
  t.add('ip arp inspection filter <word:acl> vlan <word:list> static', H, setFilter(true));
  t.add('no ip arp inspection filter <word:acl> vlan <word:list>', H, (c, a) => {
    const v = vlans(c, a);
    if (!v) return;
    const d = dai(c);
    d.filters = d.filters.map((f) => (f.acl === a.acl ? { ...f, vlans: f.vlans.filter((x) => !v.includes(x)) } : f)).filter((f) => f.vlans.length);
    commit(c);
  });
  // Static bindings for IP source guard and DAI
  const binding = (c: Ctx, a: Args) => {
    const mac = String(a.hw).toLowerCase();
    if (!MAC_RE.test(mac)) return caret(c, a['@hw'] as number), null;
    const ip = parseIp(String(a.addr));
    if (ip === null) return caret(c, a['@addr'] as number), null;
    if (!c.dev.running.interfaces[String(a.if)]) return caret(c, a['@if'] as number), null;
    return { mac, vlan: a.id as number, ip, iface: String(a.if) };
  };
  t.add('ip source binding <word:hw> vlan <number:id:1-4094> <ip:addr> interface <iface:if>', H, (c, a) => {
    const b = binding(c, a);
    if (!b) return;
    const list = (cfg(c).sourceBindings ??= []).filter((x) => x.mac !== b.mac || x.vlan !== b.vlan);
    list.push(b);
    cfg(c).sourceBindings = list;
    commit(c);
  });
  t.add('no ip source binding <word:hw> vlan <number:id:1-4094> <ip:addr> interface <iface:if>', H, (c, a) => {
    cfg(c).sourceBindings = (cfg(c).sourceBindings ?? []).filter((x) => x.mac !== String(a.hw).toLowerCase() || x.vlan !== a.id);
    commit(c);
  });
}

// ---- interface --------------------------------------------------------------------------------

export function addSecurityInterface(t: Tree, kind: DeviceKind): void {
  const each = (fn: (c: Ctx, ifc: DeviceConfig['interfaces'][string], a: Args) => void) => (c: Ctx, a: Args) => {
    for (const n of c.s.ifContext) {
      const ifc = c.dev.running.interfaces[n];
      if (ifc) fn(c, ifc, a);
    }
    commit(c);
  };
  if (kind === 'router' || kind === 'l3switch') {
    t.add('ip dhcp relay information trusted', H, each((_c, ifc) => void (ifc.relayInfoTrusted = true)));
    t.add('no ip dhcp relay information trusted', H, each((_c, ifc) => void delete ifc.relayInfoTrusted));
  }
  if (!isSwitchKind(kind)) return;
  t.add('ip dhcp snooping trust', H, each((_c, ifc) => void (ifc.snoopTrust = true)));
  t.add('no ip dhcp snooping trust', H, each((_c, ifc) => void delete ifc.snoopTrust));
  t.add('ip dhcp snooping limit rate <number:pps:1-2048>', H, each((_c, ifc, a) => void (ifc.snoopRate = a.pps as number)));
  t.add('no ip dhcp snooping limit rate', H, each((_c, ifc) => void delete ifc.snoopRate));
  t.add('ip arp inspection trust', H, each((_c, ifc) => void (ifc.daiTrust = true)));
  t.add('no ip arp inspection trust', H, each((_c, ifc) => void delete ifc.daiTrust));
  t.add('ip arp inspection limit rate <number:pps:0-2048>', H, each((_c, ifc, a) => void (ifc.daiRate = a.pps as number)));
  t.add('ip arp inspection limit none', H, each((_c, ifc) => void (ifc.daiRate = null)));
  t.add('no ip arp inspection limit', H, each((_c, ifc) => void delete ifc.daiRate));
  t.add('no ip arp inspection limit rate', H, each((_c, ifc) => void delete ifc.daiRate));
  t.add('ip verify source', H, each((c, ifc) => {
    if (!ifc.switchport) return void c.out.push('% IP source guard is only supported on Layer 2 interfaces');
    ifc.verifySource = true;
  }));
  t.add('no ip verify source', H, each((_c, ifc) => void delete ifc.verifySource));
  t.add('mac access-group <word:name> in', H, each((c, ifc, a) => {
    if (!ifc.switchport) return void c.out.push('% MAC access-groups are only supported on Layer 2 interfaces');
    ifc.macAccessGroup = String(a.name);
  }));
  t.add('no mac access-group <word:name> in', H, each((_c, ifc) => void delete ifc.macAccessGroup));
}

// ---- show / clear -----------------------------------------------------------------------------

export function addSecurityShows(t: Tree, kind: DeviceKind, privileged: boolean): void {
  if (!isSwitchKind(kind)) return;
  t.add('show ip dhcp snooping', H, (c) => c.out.push(...showSnooping(c.dev)));
  t.add('show ip dhcp snooping binding', H, (c) => c.out.push(...showSnoopBindings(c.net, c.dev)));
  t.add('show ip arp inspection', H, (c) => c.out.push(...showArpInspection(c.dev)));
  t.add('show ip arp inspection vlan <number:id:1-4094>', H, (c, a) => c.out.push(...showArpInspection(c.dev, a.id as number)));
  t.add('show ip arp inspection interfaces', H, (c) => c.out.push(...showArpInspectionInterfaces(c.dev, shortIfName)));
  t.add('show ip arp inspection statistics', H, (c) => c.out.push(...showArpInspection(c.dev).slice(-2 - (c.dev.running.dai?.vlans.length ?? 0))));
  t.add('show ip verify source', H, (c) => c.out.push(...showVerifySource(c.net, c.dev, shortIfName)));
  t.add('show ip source binding', H, (c) => c.out.push(...showSourceBindings(c.net, c.dev)));
  t.add('show arp access-list', H, (c) => {
    for (const [name, list] of Object.entries(c.dev.running.arpAcls ?? {})) c.out.push(`ARP access list ${name}`, ...list.map((e) => `    ${arpEntryText(e)}`));
  });
  t.add('show vlan access-map', H, (c) => c.out.push(...showVlanMaps(c)));
  t.add('show vlan access-map <word:name>', H, (c, a) => c.out.push(...showVlanMaps(c, String(a.name))));
  t.add('show vlan filter', H, (c) => {
    for (const f of c.dev.running.vlanFilters ?? []) c.out.push(`VLAN Map ${f.map} is filtering VLANs:`, `  ${formatVlanList(f.vlans)}`);
  });
  t.add('show mac access-group', H, (c) => {
    for (const ifc of Object.values(c.dev.running.interfaces)) {
      if (!ifc.switchport || !c.dev.hardware[ifc.name]) continue;
      c.out.push(`Interface ${ifc.name}:`, `   Inbound access-list is ${ifc.macAccessGroup ?? 'not set'}`);
    }
  });
  if (privileged) {
    t.add('clear ip dhcp snooping binding *', H, (c) => void (c.dev.snoopBindings = {}));
    t.add('clear ip arp inspection statistics', H, (c) => void (c.dev.daiDrops = 0));
  }
}

function showVlanMaps(c: Ctx, only?: string): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(c.dev.running.vlanMaps ?? {})) {
    if (only !== undefined && name !== only) continue;
    for (const e of list) {
      out.push(`Vlan access-map "${name}"  ${e.seq}`, '  Match clauses:');
      for (const m of e.matchIp) out.push(`    ip  address: ${m}`);
      for (const m of e.matchMac) out.push(`    mac address: ${m}`);
      out.push('  Action:', `    ${e.action}`);
    }
  }
  return out;
}

// ---- show running-config ----------------------------------------------------------------------

/** Global lines for `show run`: time ranges, MAC/ARP ACLs, VLAN maps, snooping, DAI, static bindings. */
export function securityGlobalLines(d: DeviceConfig): string[] {
  const out: string[] = [];
  const s = d.snooping;
  if (s?.vlans.length) out.push(`ip dhcp snooping vlan ${formatVlanList(s.vlans)}`);
  if (s && !s.option82) out.push('no ip dhcp snooping information option');
  if (s?.enabled) out.push('ip dhcp snooping');
  if (d.relayTrustAll) out.push('ip dhcp relay information trust-all');
  for (const b of d.sourceBindings ?? []) out.push(`ip source binding ${b.mac} vlan ${b.vlan} ${formatIp(b.ip)} interface ${shortIfName(b.iface)}`);
  if (d.dai?.vlans.length) out.push(`ip arp inspection vlan ${formatVlanList(d.dai.vlans)}`);
  for (const f of d.dai?.filters ?? []) out.push(`ip arp inspection filter ${f.acl} vlan ${formatVlanList(f.vlans)}${f.static ? ' static' : ''}`);
  if (d.dai?.validate.length) out.push(`ip arp inspection validate ${d.dai.validate.join(' ')}`);
  if (out.length) out.push('!');
  for (const [name, r] of Object.entries(d.timeRanges ?? {})) out.push(`time-range ${name}`, ...timeRangeLines(r), '!');
  for (const m of Object.values(d.macAcls ?? {})) out.push(`mac access-list extended ${m.name}`, ...m.entries.map((e) => ` ${macEntryText(e)}`), '!');
  for (const [name, list] of Object.entries(d.arpAcls ?? {})) out.push(`arp access-list ${name}`, ...list.map((e) => ` ${arpEntryText(e)}`), '!');
  for (const [name, list] of Object.entries(d.vlanMaps ?? {})) {
    for (const e of list) {
      out.push(`vlan access-map ${name} ${e.seq}`);
      for (const m of e.matchIp) out.push(` match ip address ${m}`);
      for (const m of e.matchMac) out.push(` match mac address ${m}`);
      out.push(` action ${e.action}`);
    }
    out.push('!');
  }
  for (const f of d.vlanFilters ?? []) out.push(`vlan filter ${f.map} vlan-list ${formatVlanList(f.vlans)}`);
  if (d.vlanFilters?.length) out.push('!');
  return out;
}

export function securityInterfaceLines(ifc: DeviceConfig['interfaces'][string]): string[] {
  const out: string[] = [];
  if (ifc.switchport && ifc.accessGroup?.in) out.push(` ip access-group ${ifc.accessGroup.in} in`);
  if (ifc.macAccessGroup) out.push(` mac access-group ${ifc.macAccessGroup} in`);
  if (ifc.daiTrust) out.push(' ip arp inspection trust');
  if (ifc.daiRate === null) out.push(' ip arp inspection limit none');
  else if (ifc.daiRate !== undefined) out.push(` ip arp inspection limit rate ${ifc.daiRate}`);
  if (ifc.verifySource) out.push(' ip verify source');
  if (ifc.snoopRate !== undefined) out.push(` ip dhcp snooping limit rate ${ifc.snoopRate}`);
  if (ifc.snoopTrust) out.push(' ip dhcp snooping trust');
  if (ifc.relayInfoTrusted) out.push(' ip dhcp relay information trusted');
  return out;
}
