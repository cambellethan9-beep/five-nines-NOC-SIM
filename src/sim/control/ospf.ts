// OSPFv2. Interfaces join through network statements (or `ip ospf <pid> area <a>`), neighbors form only when
// hello/dead timers, area, network type, authentication, mask and stub flags agree and no ACL drops protocol 89,
// an MTU mismatch leaves them stuck in EXSTART, and SPF builds intra-area, inter-area and external routes.

import { classfulPrefix, inSubnet, networkOf, type Ipv4 } from '../ip';
import type { Network } from '../network';
import type { Route } from '../routing';
import type { Device } from '../types';
import { autoRouterId, bandwidthKbps, ipMtu, onSameSegment, protocolPermitted, upInterfaces, wildcardMatch, type RIface } from './common';
import { isPassive, type OspfProcess } from './config';

export type OspfNetType = 'broadcast' | 'point-to-point' | 'loopback';

export interface OspfIf {
  inst: OspfInstance;
  iface: RIface;
  area: number;
  passive: boolean;
  cost: number;
  hello: number;
  dead: number;
  priority: number;
  type: OspfNetType;
  mtu: number;
  mtuIgnore: boolean;
  auth: string;
  viaInterfaceCmd: boolean;
  /** DR/BDR on this segment (router IDs and interface addresses), for broadcast networks. */
  dr?: { rid: Ipv4; addr: Ipv4 } | null;
  bdr?: { rid: Ipv4; addr: Ipv4 } | null;
  role: 'DR' | 'BDR' | 'DROTHER' | 'P2P' | 'LOOP' | 'WAIT' | 'DOWN';
}

export interface OspfNbr {
  local: OspfIf;
  remote: OspfIf;
  state: 'FULL' | '2WAY' | 'EXSTART';
}

export interface OspfInstance {
  dev: Device;
  proc: OspfProcess;
  rid: Ipv4;
  ifaces: OspfIf[];
  neighbors: OspfNbr[];
  areas: Set<number>;
  abr: boolean;
  asbr: boolean;
  /** Externals this router originates (redistribution, default-information originate). */
  externals: { network: Ipv4; prefix: number; metric: number; type: 1 | 2 }[];
}

export interface OspfEvent {
  device: string;
  message: string;
}

export interface OspfResult {
  instances: OspfInstance[];
  routes: Map<string, Route[]>;
  /** Problems IOS logs (area mismatch, duplicate router ID). */
  events: OspfEvent[];
}

function ifParams(net: Network, d: Device, iface: RIface, proc: OspfProcess) {
  const o = d.running.interfaces[iface.name]?.ospf ?? {};
  const loop = iface.name.startsWith('Loopback');
  const type: OspfNetType = o.network ?? (loop ? 'loopback' : 'broadcast');
  const hello = o.hello ?? 10;
  const auto = Math.max(1, Math.floor((proc.refBw * 1000) / bandwidthKbps(d, iface.name, net)));
  return {
    cost: o.cost ?? auto,
    hello,
    dead: o.dead ?? hello * 4,
    priority: o.priority ?? 1,
    type,
    mtuIgnore: !!o.mtuIgnore,
    auth: o.auth === 'md5' ? `md5:${JSON.stringify(o.mdKeys ?? {})}` : o.auth === 'simple' ? `simple:${o.authKey ?? ''}` : 'null',
  };
}

/** Which area (if any) an interface joins: interface command first, then the most specific network statement. */
function areaFor(d: Device, iface: RIface, proc: OspfProcess): { area: number; viaIf: boolean } | null {
  const o = d.running.interfaces[iface.name]?.ospf?.area;
  if (o && o.pid === proc.pid) return { area: o.area, viaIf: true };
  const matches = proc.networks.filter((n) => wildcardMatch(iface.address, n.addr, n.wildcard));
  if (!matches.length) return null;
  // IOS checks network statements from most to least specific.
  matches.sort((a, b) => a.wildcard - b.wildcard);
  return { area: matches[0].area, viaIf: false };
}

function buildInstances(net: Network, devices: Device[]): OspfInstance[] {
  const out: OspfInstance[] = [];
  for (const d of devices) {
    for (const proc of d.running.routing?.ospf ?? []) {
      const inst: OspfInstance = {
        dev: d,
        proc,
        rid: proc.routerId ?? autoRouterId(net, d),
        ifaces: [],
        neighbors: [],
        areas: new Set(),
        abr: false,
        asbr: false,
        externals: [],
      };
      for (const i of upInterfaces(net, d)) {
        const a = areaFor(d, i, proc);
        if (!a) continue;
        const p = ifParams(net, d, i, proc);
        inst.ifaces.push({
          inst,
          iface: i,
          area: a.area,
          viaInterfaceCmd: a.viaIf,
          passive: isPassive(proc.passive, i.name) || p.type === 'loopback',
          ...p,
          mtu: ipMtu(d, i.name),
          role: p.type === 'loopback' ? 'LOOP' : p.type === 'point-to-point' ? 'P2P' : 'WAIT',
        });
        inst.areas.add(a.area);
      }
      inst.abr = inst.areas.has(0) && inst.areas.size > 1;
      out.push(inst);
    }
  }
  return out;
}

function stubFlag(inst: OspfInstance, area: number): string {
  const a = inst.proc.areas[area];
  return a?.stub ? 'stub' : 'normal';
}

function formNeighbors(net: Network, insts: OspfInstance[], events: OspfEvent[]): void {
  const all = insts.flatMap((i) => i.ifaces.filter((f) => !f.passive && f.type !== 'loopback'));
  for (let x = 0; x < all.length; x++) {
    for (let y = x + 1; y < all.length; y++) {
      const a = all[x];
      const b = all[y];
      if (a.inst.dev.id === b.inst.dev.id || !onSameSegment(net, a.iface, b.iface)) continue;
      const hearsA = protocolPermitted(a.iface, b.iface, { proto: 'ospf' }, 0xe0000005);
      const hearsB = protocolPermitted(b.iface, a.iface, { proto: 'ospf' }, 0xe0000005);
      if (!hearsA || !hearsB) continue;
      if (a.area !== b.area) {
        for (const [rx, tx] of [[a, b], [b, a]] as const) {
          events.push({
            device: rx.inst.dev.id,
            message: `%OSPF-4-ERRRCV: Received invalid packet: mismatched area ID${rx.area === 0 || tx.area === 0 ? ' from backbone area must be virtual-link but not found' : ''} from ${fmt(tx.iface.address)}, ${rx.iface.name}`,
          });
        }
        continue;
      }
      if (a.inst.rid === b.inst.rid) {
        for (const [rx, tx] of [[a, b], [b, a]] as const) {
          events.push({ device: rx.inst.dev.id, message: `%OSPF-4-DUP_RTRID_NBR: OSPF detected duplicate router-id ${fmt(tx.inst.rid)} from ${fmt(tx.iface.address)} on interface ${rx.iface.name}` });
        }
        continue;
      }
      // Silent mismatches: IOS only reports these with debugging on.
      if (a.hello !== b.hello || a.dead !== b.dead || a.type !== b.type || a.auth !== b.auth) continue;
      if (a.type === 'broadcast' && a.iface.prefix !== b.iface.prefix) continue;
      if (stubFlag(a.inst, a.area) !== stubFlag(b.inst, b.area)) continue;
      const mtuOk = a.mtu === b.mtu || (a.mtu > b.mtu ? b.mtuIgnore : a.mtuIgnore);
      const state: OspfNbr['state'] = mtuOk ? 'FULL' : 'EXSTART';
      a.inst.neighbors.push({ local: a, remote: b, state });
      b.inst.neighbors.push({ local: b, remote: a, state });
    }
  }
  // DR/BDR election per broadcast segment: highest priority, then highest router ID; priority 0 never wins.
  for (const inst of insts) {
    for (const f of inst.ifaces) {
      if (f.type !== 'broadcast') continue;
      const peers = inst.neighbors.filter((n) => n.local === f).map((n) => n.remote);
      const seg = [f, ...peers].filter((x) => x.priority > 0 && !x.passive);
      seg.sort((p, q) => q.priority - p.priority || q.inst.rid - p.inst.rid);
      const dr = seg[0];
      const bdr = seg[1];
      f.dr = dr ? { rid: dr.inst.rid, addr: dr.iface.address } : null;
      f.bdr = bdr ? { rid: bdr.inst.rid, addr: bdr.iface.address } : null;
      f.role = f.passive ? 'DR' : dr === f ? 'DR' : bdr === f ? 'BDR' : 'DROTHER';
      if (!peers.length) f.role = 'DR';
    }
  }
  // Two DROTHERs stay at 2WAY; everyone goes FULL with the DR and BDR.
  for (const inst of insts) {
    for (const n of inst.neighbors) {
      if (n.state !== 'FULL' || n.local.type !== 'broadcast') continue;
      const both = [n.local.role, n.remote.role];
      if (both.every((r) => r === 'DROTHER')) n.state = '2WAY';
    }
  }
}

const fmt = (ip: Ipv4) => [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.');

interface Hop {
  iface: string;
  nextHop: Ipv4;
}

/** Dijkstra from one instance; returns distance and first hops to every reachable instance. */
function spf(src: OspfInstance, insts: OspfInstance[]): Map<OspfInstance, { dist: number; hops: Hop[] }> {
  const res = new Map<OspfInstance, { dist: number; hops: Hop[] }>([[src, { dist: 0, hops: [] }]]);
  const done = new Set<OspfInstance>();
  while (true) {
    let best: OspfInstance | null = null;
    for (const [i, r] of res) if (!done.has(i) && (best === null || r.dist < res.get(best)!.dist)) best = i;
    if (!best) break;
    done.add(best);
    const cur = res.get(best)!;
    for (const n of best.neighbors) {
      if (n.state === 'EXSTART') continue;
      const nd = cur.dist + n.local.cost;
      const hops = best === src ? [{ iface: n.local.iface.name, nextHop: n.remote.iface.address }] : cur.hops;
      const prev = res.get(n.remote.inst);
      if (!prev || nd < prev.dist) res.set(n.remote.inst, { dist: nd, hops: [...hops] });
      else if (nd === prev.dist && !done.has(n.remote.inst)) {
        for (const h of hops) if (!prev.hops.some((p) => p.iface === h.iface && p.nextHop === h.nextHop)) prev.hops.push(h);
      }
    }
  }
  void insts;
  return res;
}

function advertised(f: OspfIf): { network: Ipv4; prefix: number } {
  if (f.type === 'loopback') return { network: f.iface.address, prefix: 32 };
  return { network: networkOf(f.iface.address, f.iface.prefix), prefix: f.iface.prefix };
}

export function computeOspf(net: Network, devices: Device[], rib: Map<string, Route[]>, now: number): OspfResult {
  const insts = buildInstances(net, devices);
  const events: OspfEvent[] = [];
  formNeighbors(net, insts, events);

  // Externals: redistribution and default-information originate (using the previous pass's routing tables).
  for (const inst of insts) {
    const table = rib.get(inst.dev.id) ?? [];
    for (const r of inst.proc.redistribute) {
      const picked = table.filter((t) => matchesSource(t, r.source, r.id) && !(t.code === 'O' && t.source === `ospf ${inst.proc.pid}`));
      for (const t of picked) {
        if (!r.subnets && t.prefix !== classfulPrefix(t.network) && t.prefix !== 0) continue;
        if (t.prefix === 0) continue; // a default only goes out with default-information originate
        inst.externals.push({ network: t.network, prefix: t.prefix, metric: r.metric?.[0] ?? (r.source === 'bgp' ? 1 : 20), type: r.metricType ?? 2 });
      }
    }
    const d = inst.proc.defaultOriginate;
    if (d && (d.always || table.some((t) => t.prefix === 0 && !(t.code === 'O' && t.source === `ospf ${inst.proc.pid}`)))) {
      inst.externals.push({ network: 0, prefix: 0, metric: d.metric ?? 1, type: d.metricType ?? 2 });
    }
    inst.asbr = inst.externals.length > 0;
  }

  const routes = new Map<string, Route[]>();
  const abrFor = (area: number) => insts.filter((i) => i.abr && i.areas.has(area));
  for (const r of insts) {
    const tree = spf(r, insts);
    const own = upInterfaces(net, r.dev);
    const connected = (n: Ipv4, p: number) => own.some((i) => networkOf(i.address, Math.min(i.prefix, p)) === n && i.prefix <= p && inSubnet(n, i.address, i.prefix));
    const stubOnly = !r.areas.has(0) && r.areas.size > 0 && [...r.areas].every((a) => r.proc.areas[a]?.stub);
    const totallyStubby = stubOnly && [...r.areas].some((a) => abrFor(a).some((x) => x.proc.areas[a]?.noSummary));
    const best = new Map<string, Route[]>();
    const offer = (rt: Route) => {
      const key = `${rt.network}/${rt.prefix}`;
      const cur = best.get(key);
      const rank = (x: Route) => (x.sub === undefined ? 0 : x.sub === 'IA' ? 1 : x.sub === 'E1' ? 2 : 3);
      if (!cur || rank(rt) < rank(cur[0]) || (rank(rt) === rank(cur[0]) && rt.metric < cur[0].metric)) best.set(key, [rt]);
      else if (rank(rt) === rank(cur[0]) && rt.metric === cur[0].metric && cur.length < 4 && !cur.some((c) => c.nextHop === rt.nextHop)) cur.push(rt);
    };
    const mk = (x: OspfInstance, network: Ipv4, prefix: number, metric: number, sub: Route['sub'], hops: Hop[]): Route[] =>
      hops.map((h) => ({
        code: 'O',
        sub,
        network,
        prefix,
        distance: 110,
        metric,
        nextHop: h.nextHop,
        iface: h.iface,
        isDefault: prefix === 0,
        source: `ospf ${r.proc.pid}`,
        originator: x.rid,
        since: now,
      }));
    for (const [x, path] of tree) {
      if (x === r) continue;
      for (const f of x.ifaces) {
        const p = advertised(f);
        if (connected(p.network, p.prefix)) continue;
        let sub: Route['sub'];
        if (r.areas.has(f.area)) sub = undefined;
        else {
          if (totallyStubby) continue;
          const reachesBackbone = f.area === 0 || abrFor(f.area).length > 0;
          const weReachBackbone = r.areas.has(0) || [...r.areas].some((a) => abrFor(a).length > 0);
          if (!reachesBackbone || !weReachBackbone) continue;
          sub = 'IA';
        }
        for (const rt of mk(x, p.network, p.prefix, path.dist + f.cost, sub, path.hops)) offer(rt);
      }
      if (!stubOnly) {
        for (const e of x.externals) {
          if (connected(e.network, e.prefix) && e.prefix !== 0) continue;
          for (const rt of mk(x, e.network, e.prefix, e.type === 1 ? e.metric + path.dist : e.metric, e.type === 1 ? 'E1' : 'E2', path.hops)) offer(rt);
        }
      }
    }
    // Stub areas get a default from their ABR instead of external routes.
    if (stubOnly) {
      for (const a of r.areas) {
        for (const abr of abrFor(a)) {
          const path = tree.get(abr);
          if (path) for (const rt of mk(abr, 0, 0, path.dist + 1, 'IA', path.hops)) offer(rt);
        }
      }
    }
    const list = [...best.values()].flat();
    const prev = routes.get(r.dev.id) ?? [];
    routes.set(r.dev.id, [...prev, ...list]);
  }
  return { instances: insts, routes, events };
}

/** Does a routing-table entry come from the given redistribution source? */
export function matchesSource(t: Route, source: string, id?: number): boolean {
  switch (source) {
    case 'connected':
      return t.code === 'C';
    case 'static':
      return t.code === 'S';
    case 'ospf':
      return t.code === 'O' && t.source === `ospf ${id}`;
    case 'eigrp':
      return t.code === 'D' && t.source === `eigrp ${id}`;
    case 'rip':
      return t.code === 'R';
    case 'bgp':
      return t.code === 'B';
  }
  return false;
}
