// Dynamic routing commands: `router ospf|eigrp|rip|bgp` and their sub-modes (including named-mode EIGRP's
// address-family / af-interface / topology), interface-level `ip ospf ...`, `bandwidth`, `delay` and `mtu`.

import { classfulPrefix, formatIp, maskToPrefix, networkOf, parseIp } from '../ip';
import {
  emptyRouting,
  newBgp,
  newEigrp,
  newOspf,
  newRip,
  parseArea,
  type BgpConfig,
  type EigrpProcess,
  type OspfProcess,
  type PassiveConfig,
  type Redistribute,
  type RedistSource,
  type RipConfig,
  type RoutingConfig,
} from '../control/config';
import { caret, commit, type Ctx, type Tree } from './context';
import type { Args } from './parser';

export interface RouterCtx {
  proto: 'ospf' | 'eigrp' | 'rip' | 'bgp';
  /** OSPF pid, EIGRP AS (classic or the AF's AS), BGP AS. */
  id: number;
  /** Named-mode EIGRP instance name. */
  name?: string;
  /** In `af-interface`: the interface, or 'default'. */
  afIface?: string;
}

const HR: Record<string, string> = {
  router: 'Enable a routing process',
  ospf: 'Open Shortest Path First (OSPF)',
  eigrp: 'Enhanced Interior Gateway Routing Protocol (EIGRP)',
  rip: 'Routing Information Protocol (RIP)',
  bgp: 'Border Gateway Protocol (BGP)',
  pid: 'Process ID',
  asn: 'Autonomous System',
  name: 'EIGRP Virtual-Instance Name',
  network: 'Enable routing on an IP network',
  addr: 'Network number',
  wild: 'Wildcard bits',
  area: 'OSPF area parameters',
  aid: 'OSPF area ID as a decimal value or in IP address format',
  'router-id': 'router-id for this OSPF process',
  rid: 'OSPF router-id in IP address format',
  'passive-interface': 'Suppress routing updates on an interface',
  default: 'Suppress routing updates on all interfaces',
  if: 'Interface name',
  'default-information': 'Control distribution of default information',
  originate: 'Distribute a default route',
  opts: 'always | metric N | metric-type 1|2',
  redistribute: 'Redistribute information from another routing protocol',
  src: 'connected | static | ospf | eigrp | rip | bgp',
  stub: 'Specify a stub area',
  'no-summary': 'Do not send summary LSA into stub area',
  'auto-cost': 'Calculate OSPF interface cost according to bandwidth',
  'reference-bandwidth': 'Use reference bandwidth method to assign OSPF cost',
  bw: 'The reference bandwidth in terms of Mbits per second',
  'log-adjacency-changes': 'Log changes in adjacency state',
  'auto-summary': 'Enable automatic network number summarization',
  metric: 'Modify metrics and parameters for advertisement',
  weights: 'Modify metric coefficients',
  tos: 'Type Of Service (Only TOS 0 supported)',
  'default-metric': 'Set metric of redistributed routes',
  version: 'Set routing protocol version',
  ver: 'version',
  neighbor: 'Specify a neighbor router',
  peer: 'Neighbor address',
  'remote-as': 'Specify a BGP neighbor',
  ras: 'AS of remote neighbor',
  description: 'Neighbor specific description',
  text: 'Up to 80 characters describing this neighbor',
  shutdown: 'Administratively shut down this neighbor',
  'ebgp-multihop': 'Allow EBGP neighbors not on directly connected networks',
  hops: 'maximum hop count',
  'next-hop-self': 'Disable the next hop calculation for this neighbor',
  'default-originate': 'Originate default route to this neighbor',
  'update-source': 'Source of routing updates',
  mask: 'Network mask',
  nmask: 'Network mask',
  'log-neighbor-changes': 'Enable logging of BGP neighbor resets',
  'address-family': 'Enter Address Family command mode',
  ipv4: 'Address family',
  unicast: 'Address Family modifier',
  'autonomous-system': 'Specify Address-Family Autonomous System Number',
  'af-interface': 'Enter Address Family interface configuration',
  topology: 'Topology configuration mode',
  base: 'Base topology',
  'exit-address-family': 'Exit Address Family configuration mode',
  'exit-af-interface': 'Exit from Address Family Interface configuration mode',
  'exit-af-topology': 'Exit from Address Family Topology configuration mode',
  no: 'Negate a command or set its defaults',
  ip: 'Interface Internet Protocol config commands',
  cost: 'Interface cost',
  'hello-interval': 'Time between HELLO packets',
  'dead-interval': 'Interval after which a neighbor is declared dead',
  priority: 'Router priority',
  'point-to-point': 'Specify OSPF point-to-point network',
  broadcast: 'Specify OSPF broadcast multi-access network',
  'mtu-ignore': 'Ignores the MTU in DBD packets',
  authentication: 'Enable authentication',
  'message-digest': 'Use message-digest authentication',
  null: 'Use no authentication',
  'authentication-key': 'Authentication password (key)',
  key: 'The OSPF password (key)',
  'message-digest-key': 'Message digest authentication password (key)',
  kid: 'Key ID',
  md5: 'Use MD5 algorithm',
  bandwidth: 'Set bandwidth informational parameter',
  kbps: 'Bandwidth in kilobits',
  delay: 'Specify interface throughput delay',
  tens: 'Throughput delay (tens of microseconds)',
  mtu: 'Set the interface Maximum Transmission Unit (MTU)',
  bytes: 'MTU (bytes)',
  n: 'Value',
};

const routing = (c: Ctx): RoutingConfig => (c.dev.running.routing ??= emptyRouting());

function ctxOf(c: Ctx): RouterCtx {
  return c.s.routerCtx!;
}

function ospfProc(c: Ctx): OspfProcess {
  return routing(c).ospf.find((p) => p.pid === ctxOf(c).id)!;
}

function eigrpProc(c: Ctx): EigrpProcess {
  const r = ctxOf(c);
  return routing(c).eigrp.find((p) => (r.name ? p.name === r.name : p.asn === r.id && !p.name))!;
}

function passiveOf(c: Ctx): PassiveConfig {
  const r = ctxOf(c);
  if (r.proto === 'ospf') return ospfProc(c).passive;
  if (r.proto === 'eigrp') return eigrpProc(c).passive;
  return routing(c).rip!.passive;
}

function redistTarget(c: Ctx): { list: Redistribute[]; proto: string } {
  const r = ctxOf(c);
  if (r.proto === 'ospf') return { list: ospfProc(c).redistribute, proto: 'ospf' };
  if (r.proto === 'eigrp') return { list: eigrpProc(c).redistribute, proto: 'eigrp' };
  if (r.proto === 'rip') return { list: routing(c).rip!.redistribute, proto: 'rip' };
  return { list: routing(c).bgp!.redistribute, proto: 'bgp' };
}

/** Parses "ospf 1 metric 20 metric-type 1 subnets" for `redistribute`. */
function parseRedistribute(c: Ctx, a: Args, into: string): Redistribute | null {
  const text = `${a.src as string}${a.opts !== undefined ? ' ' + (a.opts as string) : ''}`;
  const base = a['@src'] as number;
  const w: { t: string; at: number }[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) w.push({ t: m[0].toLowerCase(), at: base + m.index });
  const sources: RedistSource[] = ['connected', 'static', 'ospf', 'eigrp', 'rip', 'bgp'];
  const src = sources.find((s) => s.startsWith(w[0].t));
  if (!src) {
    caret(c, w[0].at);
    return null;
  }
  const r: Redistribute = { source: src };
  let i = 1;
  if (src === 'ospf' || src === 'eigrp' || src === 'bgp') {
    if (!w[1] || !/^\d+$/.test(w[1].t)) {
      c.out.push('% Incomplete command.', '');
      return null;
    }
    r.id = Number(w[1].t);
    i = 2;
  }
  while (i < w.length) {
    const t = w[i].t;
    if ('metric-type'.startsWith(t) && t.length > 6) {
      const v = Number(w[i + 1]?.t);
      if (v !== 1 && v !== 2) return (caret(c, w[i + 1]?.at ?? w[i].at), null);
      r.metricType = v as 1 | 2;
      i += 2;
    } else if ('metric'.startsWith(t)) {
      const count = into === 'eigrp' ? 5 : 1;
      const vals = w.slice(i + 1, i + 1 + count).map((x) => Number(x.t));
      if (vals.length < count || vals.some((v) => !Number.isFinite(v))) {
        c.out.push('% Incomplete command.', '');
        return null;
      }
      r.metric = vals;
      i += 1 + count;
    } else if ('subnets'.startsWith(t) && into === 'ospf') {
      r.subnets = true;
      i++;
    } else {
      caret(c, w[i].at);
      return null;
    }
  }
  return r;
}

function addPassive(t: Tree): void {
  t.add('passive-interface <iface:if>', HR, (c, a) => {
    const p = passiveOf(c);
    const name = a.if as string;
    if (!c.dev.running.interfaces[name]) return caret(c, a['@if'] as number);
    if (p.passiveDefault) p.exceptions = p.exceptions.filter((x) => x !== name);
    else if (!p.exceptions.includes(name)) p.exceptions.push(name);
    commit(c);
  });
  t.add('no passive-interface <iface:if>', HR, (c, a) => {
    const p = passiveOf(c);
    const name = a.if as string;
    if (p.passiveDefault) {
      if (!p.exceptions.includes(name)) p.exceptions.push(name);
    } else p.exceptions = p.exceptions.filter((x) => x !== name);
    commit(c);
  });
  t.add('passive-interface default', HR, (c) => {
    const p = passiveOf(c);
    p.passiveDefault = true;
    p.exceptions = [];
    commit(c);
  });
  t.add('no passive-interface default', HR, (c) => {
    const p = passiveOf(c);
    p.passiveDefault = false;
    p.exceptions = [];
    commit(c);
  });
}

function addRedistribute(t: Tree, fixed: string): void {
  const run = (c: Ctx, a: Args) => {
    const into = fixed === 'any' ? ctxOf(c).proto : fixed;
    const r = parseRedistribute(c, a, into);
    if (!r) return;
    if (into === 'ospf' && !r.subnets) c.out.push('% Only classful networks will be redistributed');
    const target = redistTarget(c);
    const i = target.list.findIndex((x) => x.source === r.source && x.id === r.id);
    if (i >= 0) target.list[i] = r;
    else target.list.push(r);
    commit(c);
  };
  t.add('redistribute <word:src>', HR, run);
  t.add('redistribute <word:src> <line:opts>', HR, run);
  const del = (c: Ctx, a: Args) => {
    const target = redistTarget(c);
    const src = String(a.src);
    const id = a.opts !== undefined ? Number(String(a.opts).split(/\s+/)[0]) : undefined;
    target.list.splice(0, target.list.length, ...target.list.filter((x) => !(x.source.startsWith(src) && (id === undefined || x.id === id))));
    commit(c);
  };
  t.add('no redistribute <word:src>', HR, del);
  t.add('no redistribute <word:src> <line:opts>', HR, del);
}

// ---------------------------------------------------------------- global config

export function addRoutingGlobal(t: Tree): void {
  t.add('router ospf <number:pid:1-65535>', HR, (c, a) => {
    const r = routing(c);
    if (!r.ospf.some((p) => p.pid === a.pid)) r.ospf.push(newOspf(a.pid as number));
    commit(c);
    c.s.enterRouter({ proto: 'ospf', id: a.pid as number }, 'router');
  });
  t.add('no router ospf <number:pid:1-65535>', HR, (c, a) => {
    routing(c).ospf = routing(c).ospf.filter((p) => p.pid !== a.pid);
    commit(c);
  });
  t.add('router eigrp <number:asn:1-65535>', HR, (c, a) => {
    const r = routing(c);
    if (!r.eigrp.some((p) => p.asn === a.asn && !p.name)) r.eigrp.push(newEigrp(a.asn as number));
    commit(c);
    c.s.enterRouter({ proto: 'eigrp', id: a.asn as number }, 'router');
  });
  t.add('router eigrp <word:name>', HR, (c, a) => {
    c.s.enterRouter({ proto: 'eigrp', id: 0, name: String(a.name) }, 'router-named');
  });
  t.add('no router eigrp <number:asn:1-65535>', HR, (c, a) => {
    routing(c).eigrp = routing(c).eigrp.filter((p) => p.name || p.asn !== a.asn);
    commit(c);
  });
  t.add('no router eigrp <word:name>', HR, (c, a) => {
    routing(c).eigrp = routing(c).eigrp.filter((p) => p.name !== String(a.name));
    commit(c);
  });
  t.add('router rip', HR, (c) => {
    routing(c).rip ??= newRip();
    commit(c);
    c.s.enterRouter({ proto: 'rip', id: 0 }, 'router');
  });
  t.add('no router rip', HR, (c) => {
    routing(c).rip = null;
    commit(c);
  });
  t.add('router bgp <number:asn:1-4294967295>', HR, (c, a) => {
    const r = routing(c);
    if (r.bgp && r.bgp.asn !== a.asn) {
      c.out.push(`BGP is already running; AS is ${r.bgp.asn}`);
      return;
    }
    r.bgp ??= newBgp(a.asn as number);
    commit(c);
    c.s.enterRouter({ proto: 'bgp', id: a.asn as number }, 'router');
  });
  t.add('no router bgp <number:asn:1-4294967295>', HR, (c, a) => {
    if (routing(c).bgp?.asn === a.asn) routing(c).bgp = null;
    commit(c);
  });
}

// ---------------------------------------------------------------- `router ospf|eigrp|rip|bgp` mode

export function addRouterMode(t: Tree): void {
  // Commands are shared across protocols where IOS shares them; each checks which protocol it's in.
  const only = (protos: RouterCtx['proto'][], fn: (c: Ctx, a: Args) => void) => (c: Ctx, a: Args) => {
    if (!protos.includes(ctxOf(c).proto)) return caret(c, 0);
    fn(c, a);
  };

  // network statements
  t.add(
    'network <ip:addr> <ip:wild> area <word:aid>',
    HR,
    only(['ospf'], (c, a) => {
      const area = parseArea(String(a.aid));
      if (area === null) return caret(c, a['@aid'] as number);
      const p = ospfProc(c);
      const addr = parseIp(a.addr as string)!;
      const wild = parseIp(a.wild as string)!;
      if (!p.networks.some((n) => n.addr === addr && n.wildcard === wild)) p.networks.push({ addr, wildcard: wild, area });
      else c.out.push(`% OSPF: "network ${a.addr} ${a.wild} area ${a.aid}" is already configured`);
      commit(c);
    }),
  );
  t.add(
    'no network <ip:addr> <ip:wild> area <word:aid>',
    HR,
    only(['ospf'], (c, a) => {
      const p = ospfProc(c);
      p.networks = p.networks.filter((n) => !(n.addr === parseIp(a.addr as string) && n.wildcard === parseIp(a.wild as string)));
      commit(c);
    }),
  );
  t.add('network <ip:addr>', HR, (c, a) => {
    const r = ctxOf(c);
    const addr = parseIp(a.addr as string)!;
    const classful = networkOf(addr, classfulPrefix(addr));
    if (r.proto === 'rip') {
      const rip = routing(c).rip!;
      if (!rip.networks.includes(classful)) rip.networks.push(classful);
    } else if (r.proto === 'eigrp') {
      const p = eigrpProc(c);
      if (!p.networks.some((n) => n.addr === classful && n.wildcard === null)) p.networks.push({ addr: classful, wildcard: null });
    } else if (r.proto === 'bgp') {
      const b = routing(c).bgp!;
      const prefix = classfulPrefix(addr);
      if (!b.networks.some((n) => n.addr === addr && n.prefix === prefix)) b.networks.push({ addr, prefix });
    } else return caret(c, 0);
    commit(c);
  });
  t.add(
    'network <ip:addr> <ip:wild>',
    HR,
    only(['eigrp'], (c, a) => {
      const p = eigrpProc(c);
      const addr = parseIp(a.addr as string)!;
      const wild = parseIp(a.wild as string)!;
      if (!p.networks.some((n) => n.addr === addr && n.wildcard === wild)) p.networks.push({ addr: (addr & ~wild) >>> 0, wildcard: wild });
      commit(c);
    }),
  );
  t.add(
    'network <ip:addr> mask <mask:nmask>',
    HR,
    only(['bgp'], (c, a) => {
      const prefix = maskToPrefix(parseIp(a.nmask as string)!);
      if (prefix === null) return caret(c, a['@nmask'] as number);
      const b = routing(c).bgp!;
      const addr = parseIp(a.addr as string)!;
      if (!b.networks.some((n) => n.addr === addr && n.prefix === prefix)) b.networks.push({ addr, prefix });
      commit(c);
    }),
  );
  t.add('no network <ip:addr>', HR, (c, a) => {
    const r = ctxOf(c);
    const addr = parseIp(a.addr as string)!;
    const classful = networkOf(addr, classfulPrefix(addr));
    if (r.proto === 'rip') routing(c).rip!.networks = routing(c).rip!.networks.filter((n) => n !== classful);
    else if (r.proto === 'eigrp') eigrpProc(c).networks = eigrpProc(c).networks.filter((n) => !(n.addr === classful && n.wildcard === null));
    else if (r.proto === 'bgp') routing(c).bgp!.networks = routing(c).bgp!.networks.filter((n) => n.addr !== addr);
    commit(c);
  });
  t.add(
    'no network <ip:addr> <ip:wild>',
    HR,
    only(['eigrp'], (c, a) => {
      eigrpProc(c).networks = eigrpProc(c).networks.filter((n) => !(n.addr === parseIp(a.addr as string) && n.wildcard === parseIp(a.wild as string)));
      commit(c);
    }),
  );
  t.add(
    'no network <ip:addr> mask <mask:nmask>',
    HR,
    only(['bgp'], (c, a) => {
      const addr = parseIp(a.addr as string)!;
      routing(c).bgp!.networks = routing(c).bgp!.networks.filter((n) => n.addr !== addr);
      commit(c);
    }),
  );

  // router IDs
  t.add(
    'router-id <ip:rid>',
    HR,
    only(['ospf'], (c, a) => {
      const p = ospfProc(c);
      p.routerId = parseIp(a.rid as string);
      c.out.push('% OSPF: Reload or use "clear ip ospf process" command, for this to take effect');
      commit(c);
    }),
  );
  t.add('no router-id', HR, only(['ospf'], (c) => void ((ospfProc(c).routerId = null), commit(c))));
  t.add('eigrp router-id <ip:rid>', HR, only(['eigrp'], (c, a) => void ((eigrpProc(c).routerId = parseIp(a.rid as string)), commit(c))));
  t.add('eigrp log-neighbor-changes', HR, () => {});
  t.add('bgp router-id <ip:rid>', HR, only(['bgp'], (c, a) => void ((routing(c).bgp!.routerId = parseIp(a.rid as string)), commit(c))));
  t.add('bgp log-neighbor-changes', HR, () => {});
  t.add('log-adjacency-changes', HR, () => {});
  t.add('log-adjacency-changes detail', HR, () => {});

  addPassive(t);

  // OSPF specifics
  const defInfo = (c: Ctx, a: Args) => {
    const opts = String(a.opts ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const d: NonNullable<OspfProcess['defaultOriginate']> = { always: false };
    for (let i = 0; i < opts.length; i++) {
      if ('always'.startsWith(opts[i])) d.always = true;
      else if (opts[i] === 'metric') d.metric = Number(opts[++i]);
      else if (opts[i] === 'metric-type') d.metricType = Number(opts[++i]) === 1 ? 1 : 2;
      else return caret(c, (a['@opts'] as number) + String(a.opts).indexOf(opts[i]));
    }
    const r = ctxOf(c);
    if (r.proto === 'ospf') ospfProc(c).defaultOriginate = d;
    else if (r.proto === 'rip') routing(c).rip!.defaultOriginate = true;
    else return caret(c, 0);
    commit(c);
  };
  t.add('default-information originate', HR, defInfo);
  t.add('default-information originate <line:opts>', HR, defInfo);
  t.add('no default-information originate', HR, (c) => {
    const r = ctxOf(c);
    if (r.proto === 'ospf') ospfProc(c).defaultOriginate = null;
    else if (r.proto === 'rip') routing(c).rip!.defaultOriginate = false;
    commit(c);
  });
  const stub = (noSummary: boolean) =>
    only(['ospf'], (c, a) => {
      const area = parseArea(String(a.aid));
      if (area === null) return caret(c, a['@aid'] as number);
      if (area === 0) return void c.out.push('% OSPF: Backbone can not be configured as stub area');
      ospfProc(c).areas[area] = { stub: true, noSummary };
      commit(c);
    });
  t.add('area <word:aid> stub', HR, stub(false));
  t.add('area <word:aid> stub no-summary', HR, stub(true));
  t.add(
    'no area <word:aid> stub',
    HR,
    only(['ospf'], (c, a) => {
      const area = parseArea(String(a.aid));
      if (area !== null) delete ospfProc(c).areas[area];
      commit(c);
    }),
  );
  t.add(
    'auto-cost reference-bandwidth <number:bw:1-4294967>',
    HR,
    only(['ospf'], (c, a) => {
      ospfProc(c).refBw = a.bw as number;
      c.out.push('% OSPF: Reference bandwidth is changed.', '        Please ensure reference bandwidth is consistent across all routers.');
      commit(c);
    }),
  );

  // EIGRP / RIP specifics
  t.add('auto-summary', HR, (c) => {
    const r = ctxOf(c);
    if (r.proto === 'eigrp') eigrpProc(c).autoSummary = true;
    else if (r.proto === 'rip') routing(c).rip!.autoSummary = true;
    else return caret(c, 0);
    commit(c);
  });
  t.add('no auto-summary', HR, (c) => {
    const r = ctxOf(c);
    if (r.proto === 'eigrp') eigrpProc(c).autoSummary = false;
    else if (r.proto === 'rip') routing(c).rip!.autoSummary = false;
    else return caret(c, 0);
    commit(c);
  });
  t.add(
    'metric weights <number:tos:0-0> <number:k1:0-255> <number:k2:0-255> <number:k3:0-255> <number:k4:0-255> <number:k5:0-255>',
    HR,
    only(['eigrp'], (c, a) => {
      eigrpProc(c).k = [a.k1, a.k2, a.k3, a.k4, a.k5] as [number, number, number, number, number];
      commit(c);
    }),
  );
  t.add('default-metric <line:opts>', HR, (c, a) => {
    const vals = String(a.opts).split(/\s+/).map(Number);
    const r = ctxOf(c);
    if (r.proto === 'eigrp') {
      if (vals.length !== 5 || vals.some((v) => !Number.isFinite(v))) return void c.out.push('% Incomplete command.', '');
      eigrpProc(c).defaultMetric = vals;
    } else if (r.proto === 'rip') {
      if (!(vals[0] >= 1 && vals[0] <= 16)) return caret(c, a['@opts'] as number);
      routing(c).rip!.defaultMetric = vals[0];
    } else return caret(c, 0);
    commit(c);
  });
  t.add(
    'version <number:ver:1-2>',
    HR,
    only(['rip'], (c, a) => {
      (routing(c).rip as RipConfig).version = a.ver as 1 | 2;
      commit(c);
    }),
  );
  t.add('no version', HR, only(['rip'], (c) => void (((routing(c).rip as RipConfig).version = null), commit(c))));

  addRedistribute(t, 'any');

  // BGP neighbors
  const nb = (c: Ctx, a: Args) => {
    const b = routing(c).bgp as BgpConfig;
    const key = formatIp(parseIp(a.peer as string)!);
    return { b, key, n: b.neighbors[key] };
  };
  const needNb = (fn: (c: Ctx, a: Args, n: BgpConfig['neighbors'][string]) => void) =>
    only(['bgp'], (c, a) => {
      const { n } = nb(c, a);
      if (!n) return void c.out.push('% Specify remote-as or peer-group commands first');
      fn(c, a, n);
      commit(c);
    });
  t.add(
    'neighbor <ip:peer> remote-as <number:ras:1-4294967295>',
    HR,
    only(['bgp'], (c, a) => {
      const { b, key } = nb(c, a);
      b.neighbors[key] = { ...(b.neighbors[key] ?? {}), remoteAs: a.ras as number };
      commit(c);
    }),
  );
  t.add('neighbor <ip:peer> description <line:text>', HR, needNb((_c, a, n) => void (n.description = String(a.text).slice(0, 80))));
  t.add('neighbor <ip:peer> shutdown', HR, needNb((_c, _a, n) => void (n.shutdown = true)));
  t.add('no neighbor <ip:peer> shutdown', HR, needNb((_c, _a, n) => void delete n.shutdown));
  t.add('neighbor <ip:peer> ebgp-multihop', HR, needNb((_c, _a, n) => void (n.ebgpMultihop = 255)));
  t.add('neighbor <ip:peer> ebgp-multihop <number:hops:1-255>', HR, needNb((_c, a, n) => void (n.ebgpMultihop = a.hops as number)));
  t.add('neighbor <ip:peer> next-hop-self', HR, needNb((_c, _a, n) => void (n.nextHopSelf = true)));
  t.add('neighbor <ip:peer> default-originate', HR, needNb((_c, _a, n) => void (n.defaultOriginate = true)));
  t.add('neighbor <ip:peer> update-source <iface:if>', HR, needNb((_c, a, n) => void (n.updateSource = a.if as string)));
  t.add(
    'no neighbor <ip:peer>',
    HR,
    only(['bgp'], (c, a) => {
      const { b, key } = nb(c, a);
      delete b.neighbors[key];
      commit(c);
    }),
  );
  t.add(
    'no neighbor <ip:peer> remote-as <number:ras:1-4294967295>',
    HR,
    only(['bgp'], (c, a) => {
      const { b, key } = nb(c, a);
      delete b.neighbors[key];
      commit(c);
    }),
  );
}

// ---------------------------------------------------------------- named-mode EIGRP

export function addNamedEigrp(t: Tree): void {
  t.add('address-family ipv4 unicast autonomous-system <number:asn:1-65535>', HR, (c, a) => {
    const name = ctxOf(c).name!;
    const r = routing(c);
    const existing = r.eigrp.find((p) => p.name === name);
    if (existing && existing.asn !== a.asn) return void c.out.push(`% Address-family for this instance already configured with AS ${existing.asn}`);
    if (!existing) r.eigrp.push(newEigrp(a.asn as number, name));
    commit(c);
    c.s.enterRouter({ proto: 'eigrp', id: a.asn as number, name }, 'router-af');
  });
}

export function addEigrpAf(t: Tree): void {
  t.add('network <ip:addr>', HR, (c, a) => {
    const addr = parseIp(a.addr as string)!;
    const p = eigrpProc(c);
    const classful = networkOf(addr, classfulPrefix(addr));
    if (!p.networks.some((n) => n.addr === classful && n.wildcard === null)) p.networks.push({ addr: classful, wildcard: null });
    commit(c);
  });
  t.add('network <ip:addr> <ip:wild>', HR, (c, a) => {
    const p = eigrpProc(c);
    const addr = parseIp(a.addr as string)!;
    const wild = parseIp(a.wild as string)!;
    if (!p.networks.some((n) => n.addr === addr && n.wildcard === wild)) p.networks.push({ addr: (addr & ~wild) >>> 0, wildcard: wild });
    commit(c);
  });
  t.add('no network <ip:addr> <ip:wild>', HR, (c, a) => {
    eigrpProc(c).networks = eigrpProc(c).networks.filter((n) => !(n.addr === parseIp(a.addr as string) && n.wildcard === parseIp(a.wild as string)));
    commit(c);
  });
  t.add('eigrp router-id <ip:rid>', HR, (c, a) => void ((eigrpProc(c).routerId = parseIp(a.rid as string)), commit(c)));
  t.add('metric weights <number:tos:0-0> <number:k1:0-255> <number:k2:0-255> <number:k3:0-255> <number:k4:0-255> <number:k5:0-255>', HR, (c, a) => {
    eigrpProc(c).k = [a.k1, a.k2, a.k3, a.k4, a.k5] as [number, number, number, number, number];
    commit(c);
  });
  t.add('af-interface default', HR, (c) => c.s.enterRouter({ ...ctxOf(c), afIface: 'default' }, 'router-af-if'));
  t.add('af-interface <iface:if>', HR, (c, a) => {
    if (!c.dev.running.interfaces[a.if as string]) return caret(c, a['@if'] as number);
    c.s.enterRouter({ ...ctxOf(c), afIface: a.if as string }, 'router-af-if');
  });
  t.add('topology base', HR, (c) => c.s.enterRouter(ctxOf(c), 'router-af-topo'));
  t.add('exit-address-family', HR, (c) => c.s.enterRouter({ proto: 'eigrp', id: 0, name: ctxOf(c).name }, 'router-named'));
}

export function addEigrpAfInterface(t: Tree): void {
  const set = (passive: boolean) => (c: Ctx) => {
    const p = eigrpProc(c).passive;
    const target = ctxOf(c).afIface!;
    if (target === 'default') {
      p.passiveDefault = passive;
      p.exceptions = [];
    } else if (p.passiveDefault === passive) p.exceptions = p.exceptions.filter((x) => x !== target);
    else if (!p.exceptions.includes(target)) p.exceptions.push(target);
    commit(c);
  };
  t.add('passive-interface', HR, set(true));
  t.add('no passive-interface', HR, set(false));
  t.add('exit-af-interface', HR, (c) => c.s.enterRouter({ ...ctxOf(c), afIface: undefined }, 'router-af'));
}

export function addEigrpTopology(t: Tree): void {
  addRedistribute(t, 'eigrp');
  t.add('default-metric <line:opts>', HR, (c, a) => {
    const vals = String(a.opts).split(/\s+/).map(Number);
    if (vals.length !== 5 || vals.some((v) => !Number.isFinite(v))) return void c.out.push('% Incomplete command.', '');
    eigrpProc(c).defaultMetric = vals;
    commit(c);
  });
  t.add('auto-summary', HR, (c) => void ((eigrpProc(c).autoSummary = true), commit(c)));
  t.add('no auto-summary', HR, (c) => void ((eigrpProc(c).autoSummary = false), commit(c)));
  t.add('variance <number:n:1-128>', HR, () => {});
  t.add('maximum-paths <number:n:1-32>', HR, () => {});
  t.add('exit-af-topology', HR, (c) => c.s.enterRouter(ctxOf(c), 'router-af'));
}

// ---------------------------------------------------------------- interface commands

export function addRoutingInterface(t: Tree): void {
  const each = (fn: (c: Ctx, name: string, a: Args) => void) => (c: Ctx, a: Args) => {
    for (const name of c.s.ifContext) if (c.dev.running.interfaces[name]) fn(c, name, a);
    commit(c);
  };
  const ospf = (c: Ctx, name: string) => (c.dev.running.interfaces[name].ospf ??= {});
  t.add('ip ospf cost <number:n:1-65535>', HR, each((c, i, a) => void (ospf(c, i).cost = a.n as number)));
  t.add('no ip ospf cost', HR, each((c, i) => void delete ospf(c, i).cost));
  t.add('ip ospf hello-interval <number:n:1-65535>', HR, each((c, i, a) => void (ospf(c, i).hello = a.n as number)));
  t.add('no ip ospf hello-interval', HR, each((c, i) => void delete ospf(c, i).hello));
  t.add('ip ospf dead-interval <number:n:1-65535>', HR, each((c, i, a) => void (ospf(c, i).dead = a.n as number)));
  t.add('no ip ospf dead-interval', HR, each((c, i) => void delete ospf(c, i).dead));
  t.add('ip ospf priority <number:n:0-255>', HR, each((c, i, a) => void (ospf(c, i).priority = a.n as number)));
  t.add('no ip ospf priority', HR, each((c, i) => void delete ospf(c, i).priority));
  t.add('ip ospf network point-to-point', HR, each((c, i) => void (ospf(c, i).network = 'point-to-point')));
  t.add('ip ospf network broadcast', HR, each((c, i) => void (ospf(c, i).network = 'broadcast')));
  t.add('no ip ospf network', HR, each((c, i) => void delete ospf(c, i).network));
  t.add('ip ospf <number:pid:1-65535> area <word:aid>', HR, (c, a) => {
    const area = parseArea(String(a.aid));
    if (area === null) return caret(c, a['@aid'] as number);
    each((cc, i) => void (ospf(cc, i).area = { pid: a.pid as number, area }))(c, a);
  });
  t.add('no ip ospf <number:pid:1-65535> area <word:aid>', HR, each((c, i) => void delete ospf(c, i).area));
  t.add('ip ospf mtu-ignore', HR, each((c, i) => void (ospf(c, i).mtuIgnore = true)));
  t.add('no ip ospf mtu-ignore', HR, each((c, i) => void delete ospf(c, i).mtuIgnore));
  t.add('ip ospf authentication', HR, each((c, i) => void (ospf(c, i).auth = 'simple')));
  t.add('ip ospf authentication message-digest', HR, each((c, i) => void (ospf(c, i).auth = 'md5')));
  t.add('ip ospf authentication null', HR, each((c, i) => void (ospf(c, i).auth = 'null')));
  t.add('no ip ospf authentication', HR, each((c, i) => void delete ospf(c, i).auth));
  t.add('ip ospf authentication-key <word:key>', HR, each((c, i, a) => void (ospf(c, i).authKey = String(a.key).slice(0, 8))));
  t.add('no ip ospf authentication-key', HR, each((c, i) => void delete ospf(c, i).authKey));
  t.add('ip ospf message-digest-key <number:kid:1-255> md5 <word:key>', HR, each((c, i, a) => void ((ospf(c, i).mdKeys ??= {})[a.kid as number] = String(a.key))));
  t.add('no ip ospf message-digest-key <number:kid:1-255>', HR, each((c, i, a) => void delete ospf(c, i).mdKeys?.[a.kid as number]));
  t.add('bandwidth <number:kbps:1-10000000>', HR, each((c, i, a) => void (c.dev.running.interfaces[i].bandwidth = a.kbps as number)));
  t.add('no bandwidth', HR, each((c, i) => void delete c.dev.running.interfaces[i].bandwidth));
  t.add('delay <number:tens:1-16777215>', HR, each((c, i, a) => void (c.dev.running.interfaces[i].delay = a.tens as number)));
  t.add('no delay', HR, each((c, i) => void delete c.dev.running.interfaces[i].delay));
  t.add('mtu <number:bytes:64-9216>', HR, each((c, i, a) => void (c.dev.running.interfaces[i].mtu = a.bytes as number)));
  t.add('no mtu', HR, each((c, i) => void delete c.dev.running.interfaces[i].mtu));
  t.add('ip mtu <number:bytes:68-9216>', HR, each((c, i, a) => void (c.dev.running.interfaces[i].ipMtu = a.bytes as number)));
  t.add('no ip mtu', HR, each((c, i) => void delete c.dev.running.interfaces[i].ipMtu));
}
