// EIGRP (classic `router eigrp AS` and named mode). Neighbors need the same AS and K-values on a shared subnet,
// and an ACL that lets protocol 88 through. Routes use the composite metric from minimum bandwidth and total
// delay (named mode shows the 64-bit wide metric scaled for the RIB), computed distance-vector style.

import { networkOf, type Ipv4 } from '../ip';
import type { Network } from '../network';
import type { Route } from '../routing';
import type { Device } from '../types';
import { autoRouterId, bandwidthKbps, delayTens, major, onSameSegment, protocolPermitted, upInterfaces, wildcardMatch, type RIface } from './common';
import { isPassive, type EigrpProcess } from './config';
import { matchesSource } from './ospf';

export interface EigrpIf {
  inst: EigrpInstance;
  iface: RIface;
  passive: boolean;
}

export interface EigrpNbr {
  local: EigrpIf;
  remote: EigrpIf;
}

export interface EigrpEntry {
  network: Ipv4;
  prefix: number;
  bw: number;
  delay: number;
  external: boolean;
  /** Empty = connected/originated here. */
  hops: { iface: string; nextHop: Ipv4; reported: number }[];
  originator: Ipv4;
}

export interface EigrpInstance {
  dev: Device;
  proc: EigrpProcess;
  rid: Ipv4;
  ifaces: EigrpIf[];
  neighbors: EigrpNbr[];
  table: Map<string, EigrpEntry>;
}

export interface EigrpResult {
  instances: EigrpInstance[];
  routes: Map<string, Route[]>;
  events: { device: string; message: string }[];
}

/** RIB metric for bandwidth (kbps) and delay (tens of microseconds), classic or wide. */
export function eigrpMetric(proc: EigrpProcess, bw: number, delay: number): number {
  const [k1, k2, k3, k4, k5] = proc.k;
  if (proc.name) {
    const throughput = Math.floor((65536 * 1e7) / bw);
    // Delay in picoseconds x 65536 / 10^6; `delay` is in tens of microseconds.
    const latency = delay * 10 * 65536;
    let c = k1 * throughput + (k2 * throughput) / 255 + k3 * latency;
    if (k5) c = (c * k5) / (255 + k4);
    return Math.floor(c / 128);
  }
  const b = Math.floor(1e7 / bw);
  let c = k1 * b + (k2 * b) / 255 + k3 * delay;
  if (k5) c = (c * k5) / (255 + k4);
  return Math.floor(256 * c);
}

function enabled(proc: EigrpProcess, i: RIface): boolean {
  return proc.networks.some((n) => (n.wildcard === null ? major(i.address).network === major(n.addr).network : wildcardMatch(i.address, n.addr, n.wildcard)));
}

const key = (n: Ipv4, p: number) => `${n}/${p}`;
const fmt = (ip: Ipv4) => [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.');

export function computeEigrp(net: Network, devices: Device[], rib: Map<string, Route[]>, now: number): EigrpResult {
  const insts: EigrpInstance[] = [];
  const events: EigrpResult['events'] = [];
  for (const d of devices) {
    for (const proc of d.running.routing?.eigrp ?? []) {
      const inst: EigrpInstance = { dev: d, proc, rid: proc.routerId ?? autoRouterId(net, d), ifaces: [], neighbors: [], table: new Map() };
      for (const i of upInterfaces(net, d)) {
        if (!enabled(proc, i)) continue;
        inst.ifaces.push({ inst, iface: i, passive: isPassive(proc.passive, i.name) });
        const n = networkOf(i.address, i.prefix);
        inst.table.set(key(n, i.prefix), { network: n, prefix: i.prefix, bw: bandwidthKbps(d, i.name, net), delay: delayTens(d, i.name), external: false, hops: [], originator: inst.rid });
      }
      // Redistributed routes enter as externals with their seed metric (connected/static use the interface's).
      for (const r of proc.redistribute) {
        for (const t of (rib.get(d.id) ?? []).filter((x) => matchesSource(x, r.source, r.id) && !(x.code === 'D' && x.source === `eigrp ${proc.asn}`))) {
          const seed = r.metric ?? proc.defaultMetric;
          let bw: number;
          let delay: number;
          if (seed) {
            bw = seed[0];
            delay = seed[1];
          } else if ((r.source === 'connected' || r.source === 'static') && t.iface) {
            bw = bandwidthKbps(d, t.iface, net);
            delay = delayTens(d, t.iface);
          } else if (r.source === 'static' && t.nextHop !== null) {
            const via = upInterfaces(net, d).find((i) => networkOf(t.nextHop!, i.prefix) === networkOf(i.address, i.prefix));
            if (!via) continue;
            bw = bandwidthKbps(d, via.name, net);
            delay = delayTens(d, via.name);
          } else continue; // no seed metric: IOS redistributes nothing
          const k = key(t.network, t.prefix);
          if (!inst.table.has(k)) inst.table.set(k, { network: t.network, prefix: t.prefix, bw, delay, external: true, hops: [], originator: inst.rid });
        }
      }
      insts.push(inst);
    }
  }

  // Neighbors.
  for (let x = 0; x < insts.length; x++) {
    for (let y = x + 1; y < insts.length; y++) {
      const A = insts[x];
      const B = insts[y];
      if (A.proc.asn !== B.proc.asn || A.dev.id === B.dev.id) continue;
      for (const a of A.ifaces) {
        for (const b of B.ifaces) {
          if (a.passive || b.passive || !onSameSegment(net, a.iface, b.iface)) continue;
          if (!protocolPermitted(a.iface, b.iface, { proto: 'eigrp' }, 0xe000000a) || !protocolPermitted(b.iface, a.iface, { proto: 'eigrp' }, 0xe000000a)) continue;
          if (A.proc.k.join() !== B.proc.k.join()) {
            for (const [rx, tx] of [[a, b], [b, a]] as const) {
              events.push({ device: rx.inst.dev.id, message: `%DUAL-5-NBRCHANGE: EIGRP-IPv4 ${A.proc.asn}: Neighbor ${fmt(tx.iface.address)} (${rx.iface.name}) is down: K-value mismatch` });
            }
            continue;
          }
          A.neighbors.push({ local: a, remote: b });
          B.neighbors.push({ local: b, remote: a });
        }
      }
    }
  }

  // Distance vector: repeat until nothing improves.
  const metricOf = (inst: EigrpInstance, e: { bw: number; delay: number }) => eigrpMetric(inst.proc, e.bw, e.delay);
  for (let round = 0; round < insts.length + 2; round++) {
    let changed = false;
    for (const R of insts) {
      for (const n of R.neighbors) {
        const S = n.remote.inst;
        for (const e of S.table.values()) {
          let net0 = e.network;
          let pre = e.prefix;
          // Auto-summary: crossing a major network boundary advertises the classful summary.
          if (S.proc.autoSummary && major(net0).network !== major(n.remote.iface.address).network) {
            const m = major(net0);
            net0 = m.network;
            pre = m.prefix;
          }
          if (e.hops.some((h) => h.iface === n.remote.iface.name)) continue; // split horizon
          const cand = { bw: Math.min(e.bw, bandwidthKbps(R.dev, n.local.iface.name, net)), delay: e.delay + delayTens(R.dev, n.local.iface.name) };
          const k = key(net0, pre);
          const cur = R.table.get(k);
          const hop = { iface: n.local.iface.name, nextHop: n.remote.iface.address, reported: metricOf(R, e) };
          if (cur && cur.hops.length === 0) continue; // connected/originated here
          const cm = metricOf(R, cand);
          if (!cur || cm < metricOf(R, cur)) {
            R.table.set(k, { network: net0, prefix: pre, ...cand, external: e.external, hops: [hop], originator: e.originator });
            changed = true;
          } else if (cm === metricOf(R, cur) && !cur.hops.some((h) => h.nextHop === hop.nextHop) && cur.hops.length < 4) {
            cur.hops.push(hop);
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }

  const routes = new Map<string, Route[]>();
  for (const R of insts) {
    const list: Route[] = [];
    for (const e of R.table.values()) {
      if (!e.hops.length) continue;
      for (const h of e.hops) {
        list.push({
          code: 'D',
          sub: e.external ? 'EX' : undefined,
          network: e.network,
          prefix: e.prefix,
          distance: e.external ? 170 : 90,
          metric: metricOf(R, e),
          nextHop: h.nextHop,
          iface: h.iface,
          isDefault: e.prefix === 0,
          source: `eigrp ${R.proc.asn}`,
          originator: e.originator,
          since: now,
        });
      }
    }
    routes.set(R.dev.id, [...(routes.get(R.dev.id) ?? []), ...list]);
  }
  return { instances: insts, routes, events };
}
