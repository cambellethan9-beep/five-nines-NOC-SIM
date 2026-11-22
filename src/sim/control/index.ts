// The control plane: runs every routing protocol over the current network state, feeds redistribution and BGP
// `network` checks with the previous pass's routing tables until things settle, caches the result per
// network version, keeps route ages stable, and logs adjacency changes like IOS.

import { formatIp } from '../ip';
import type { Network } from '../network';
import { baseTable, mergeTables, type Route } from '../routing';
import { computeBgp, type BgpResult } from './bgp';
import { routers } from './common';
import { computeEigrp, type EigrpResult } from './eigrp';
import { computeOspf, type OspfResult } from './ospf';
import { computeRip, type RipResult } from './rip';

export interface ControlState {
  version: number;
  dynamic: Map<string, Route[]>;
  ospf: OspfResult;
  eigrp: EigrpResult;
  rip: RipResult;
  bgp: BgpResult;
}

interface Snapshot {
  ospf: Map<string, { device: string; iface: string; rid: string; full: boolean }>;
  eigrp: Map<string, { device: string; asn: number; iface: string; addr: string }>;
  bgp: Map<string, { device: string; peer: string; up: boolean }>;
  events: Set<string>;
}

interface CpCache {
  state?: ControlState;
  snapshot?: Snapshot;
  since: Map<string, number>;
  computing: boolean;
}

const caches = new WeakMap<Network, CpCache>();

function cacheOf(net: Network): CpCache {
  let c = caches.get(net);
  if (!c) {
    c = { since: new Map(), computing: false };
    caches.set(net, c);
  }
  return c;
}

function hasProtocols(net: Network): boolean {
  for (const d of net.devices.values()) {
    const r = d.running.routing;
    if (r && (r.ospf.length || r.eigrp.length || r.rip || r.bgp)) return true;
  }
  return false;
}

const EMPTY = (): Omit<ControlState, 'version'> => ({
  dynamic: new Map(),
  ospf: { instances: [], routes: new Map(), events: [] },
  eigrp: { instances: [], routes: new Map(), events: [] },
  rip: { instances: [], routes: new Map() },
  bgp: { instances: [], routes: new Map() },
});

export function controlPlane(net: Network): ControlState {
  const cache = cacheOf(net);
  if (cache.state && cache.state.version === net.version) return cache.state;
  if (cache.computing) return cache.state ?? { version: -1, ...EMPTY() }; // re-entry while computing: use what we had
  cache.computing = true;
  try {
    if (!hasProtocols(net)) {
      cache.state = { version: net.version, ...EMPTY() };
      return cache.state;
    }
    const devices = routers(net);
    let rib = new Map(devices.map((d) => [d.id, baseTable(net, d)]));
    let result: Omit<ControlState, 'version'> = EMPTY();
    let last = '';
    for (let pass = 0; pass < 4; pass++) {
      const ospf = computeOspf(net, devices, rib, net.time);
      const eigrp = computeEigrp(net, devices, rib, net.time);
      const rip = computeRip(net, devices, rib, net.time);
      const bgp = computeBgp(net, devices, rib, net.time);
      const dynamic = new Map<string, Route[]>();
      for (const d of devices) {
        dynamic.set(d.id, [...(ospf.routes.get(d.id) ?? []), ...(eigrp.routes.get(d.id) ?? []), ...(rip.routes.get(d.id) ?? []), ...(bgp.routes.get(d.id) ?? [])]);
      }
      result = { dynamic, ospf, eigrp, rip, bgp };
      const next = new Map(devices.map((d) => [d.id, mergeTables(net, d, dynamic.get(d.id) ?? [])]));
      const sig = JSON.stringify([...next.entries()].map(([k, v]) => [k, v.map((r) => `${r.code}${r.sub ?? ''}${r.network}/${r.prefix}>${r.nextHop}`)]));
      rib = next;
      if (sig === last) break;
      last = sig;
    }
    // Route ages: keep when a route was first seen.
    const seen = new Set<string>();
    for (const [dev, list] of result.dynamic) {
      for (const r of list) {
        const k = `${dev}|${r.code}${r.sub ?? ''}|${r.network}/${r.prefix}|${r.nextHop}`;
        seen.add(k);
        if (!cache.since.has(k)) cache.since.set(k, net.time);
        r.since = cache.since.get(k)!;
      }
    }
    for (const k of [...cache.since.keys()]) if (!seen.has(k)) cache.since.delete(k);
    cache.state = { version: net.version, ...result };
    return cache.state;
  } finally {
    cache.computing = false;
  }
}

export function dynamicRoutes(net: Network, deviceId: string): Route[] {
  return controlPlane(net).dynamic.get(deviceId) ?? [];
}

function snapshot(net: Network, s: ControlState): Snapshot {
  const ospf: Snapshot['ospf'] = new Map();
  for (const i of s.ospf.instances) {
    for (const n of i.neighbors) {
      ospf.set(`${i.dev.id}|${n.local.iface.name}|${n.remote.inst.rid}`, { device: i.dev.id, iface: n.local.iface.name, rid: formatIp(n.remote.inst.rid), full: n.state !== 'EXSTART' });
    }
  }
  const eigrp: Snapshot['eigrp'] = new Map();
  for (const i of s.eigrp.instances) {
    for (const n of i.neighbors) {
      eigrp.set(`${i.dev.id}|${i.proc.asn}|${n.local.iface.name}|${n.remote.iface.address}`, { device: i.dev.id, asn: i.proc.asn, iface: n.local.iface.name, addr: formatIp(n.remote.iface.address) });
    }
  }
  const bgp: Snapshot['bgp'] = new Map();
  for (const i of s.bgp.instances) {
    for (const ss of i.sessions) bgp.set(`${i.dev.id}|${ss.peer}`, { device: i.dev.id, peer: formatIp(ss.peer), up: ss.state === 'Established' });
  }
  void net;
  return { ospf, eigrp, bgp, events: new Set([...s.ospf.events, ...s.eigrp.events].map((e) => `${e.device}|${e.message}`)) };
}

/** Called after each (non-silent) commit: logs neighbor changes since the last call. */
export function logControlChanges(net: Network): void {
  const cache = cacheOf(net);
  if (!hasProtocols(net) && !cache.snapshot) return;
  const state = controlPlane(net);
  const now = snapshot(net, state);
  const before = cache.snapshot;
  cache.snapshot = now;
  if (!before) return; // first look after build/load: nothing "changed"
  const pid = (device: string) => net.device(device).running.routing?.ospf[0]?.pid ?? 1;
  for (const [k, n] of now.ospf) {
    const was = before.ospf.get(k);
    if (n.full && !was?.full) net.log(n.device, `%OSPF-5-ADJCHG: Process ${pid(n.device)}, Nbr ${n.rid} on ${n.iface} from LOADING to FULL, Loading Done`);
  }
  for (const [k, n] of before.ospf) {
    if (!n.full || now.ospf.get(k)?.full) continue;
    const ifc = net.device(n.device).running.interfaces[n.iface];
    const passive = state.ospf.instances.some((i) => i.dev.id === n.device && i.ifaces.some((f) => f.iface.name === n.iface && f.passive));
    const reason = !ifc || !net.isUp(n.device, n.iface) || passive ? 'Interface down or detached' : now.ospf.get(k) ? 'Too many retransmissions' : 'Dead timer expired';
    net.log(n.device, `%OSPF-5-ADJCHG: Process ${pid(n.device)}, Nbr ${n.rid} on ${n.iface} from FULL to DOWN, Neighbor Down: ${reason}`);
  }
  for (const [k, n] of now.eigrp) {
    if (!before.eigrp.has(k)) net.log(n.device, `%DUAL-5-NBRCHANGE: EIGRP-IPv4 ${n.asn}: Neighbor ${n.addr} (${n.iface}) is up: new adjacency`);
  }
  for (const [k, n] of before.eigrp) {
    if (now.eigrp.has(k)) continue;
    const up = net.isUp(n.device, n.iface);
    net.log(n.device, `%DUAL-5-NBRCHANGE: EIGRP-IPv4 ${n.asn}: Neighbor ${n.addr} (${n.iface}) is down: ${up ? 'holding time expired' : 'interface down'}`);
  }
  for (const [k, n] of now.bgp) {
    const was = before.bgp.get(k);
    if (n.up && !was?.up) net.log(n.device, `%BGP-5-ADJCHANGE: neighbor ${n.peer} Up `);
    if (!n.up && was?.up) net.log(n.device, `%BGP-5-ADJCHANGE: neighbor ${n.peer} Down Peer closed the session`);
  }
  for (const e of now.events) {
    if (before.events.has(e)) continue;
    const [device, ...rest] = e.split('|');
    net.log(device, rest.join('|'));
  }
}

/** Forget the neighbor snapshot (after loading a save), so the next look doesn't log old changes. */
export function resetControlSnapshot(net: Network): void {
  cacheOf(net).snapshot = undefined;
}
