// RIP v1/v2. Classful network statements, hop count (16 = unreachable), version compatibility (a default router
// sends v1 and accepts both; `version 2` only speaks v2), auto-summary at major network boundaries, and v1's
// blindness to masks.

import { networkOf, type Ipv4 } from '../ip';
import type { Network } from '../network';
import type { Route } from '../routing';
import type { Device } from '../types';
import { major, onSameSegment, protocolPermitted, upInterfaces, type RIface } from './common';
import { isPassive, type RipConfig } from './config';
import { matchesSource } from './ospf';

export interface RipIf {
  inst: RipInstance;
  iface: RIface;
  passive: boolean;
}

export interface RipEntry {
  network: Ipv4;
  prefix: number;
  hops: number;
  via: { iface: string; nextHop: Ipv4 }[];
}

export interface RipInstance {
  dev: Device;
  cfg: RipConfig;
  ifaces: RipIf[];
  table: Map<string, RipEntry>;
  /** Who we hear updates from: our interface and their address. */
  sources: { local: RipIf; remote: RipIf }[];
}

export interface RipResult {
  instances: RipInstance[];
  routes: Map<string, Route[]>;
}

const key = (n: Ipv4, p: number) => `${n}/${p}`;
const sends = (c: RipConfig) => c.version ?? 1;
const receives = (c: RipConfig) => (c.version === 1 ? [1] : c.version === 2 ? [2] : [1, 2]);

export function computeRip(net: Network, devices: Device[], rib: Map<string, Route[]>, now: number): RipResult {
  const insts: RipInstance[] = [];
  for (const d of devices) {
    const cfg = d.running.routing?.rip;
    if (!cfg) continue;
    const inst: RipInstance = { dev: d, cfg, ifaces: [], table: new Map(), sources: [] };
    for (const i of upInterfaces(net, d)) {
      if (!cfg.networks.some((n) => major(n).network === major(i.address).network)) continue;
      inst.ifaces.push({ inst, iface: i, passive: isPassive(cfg.passive, i.name) });
      const n = networkOf(i.address, i.prefix);
      inst.table.set(key(n, i.prefix), { network: n, prefix: i.prefix, hops: 0, via: [] });
    }
    const table = rib.get(d.id) ?? [];
    if (cfg.defaultOriginate) inst.table.set(key(0, 0), { network: 0, prefix: 0, hops: 0, via: [] });
    for (const r of cfg.redistribute) {
      const seed = r.metric?.[0] ?? cfg.defaultMetric ?? (r.source === 'connected' || r.source === 'static' ? 1 : null);
      if (seed === null) continue; // no seed metric: infinity, nothing redistributed
      for (const t of table.filter((x) => matchesSource(x, r.source, r.id) && x.code !== 'R')) {
        const k = key(t.network, t.prefix);
        if (!inst.table.has(k)) inst.table.set(k, { network: t.network, prefix: t.prefix, hops: seed - 1, via: [] });
      }
    }
    insts.push(inst);
  }
  for (const R of insts) {
    for (const S of insts) {
      if (R === S) continue;
      for (const a of R.ifaces) {
        for (const b of S.ifaces) {
          if (b.passive || !onSameSegment(net, a.iface, b.iface)) continue;
          if (!receives(R.cfg).includes(sends(S.cfg))) continue;
          if (!protocolPermitted(b.iface, a.iface, { proto: 'udp', srcPort: 520, dstPort: 520 }, sends(S.cfg) === 1 ? 0xffffffff : 0xe0000009)) continue;
          R.sources.push({ local: a, remote: b });
        }
      }
    }
  }
  for (let round = 0; round < 16; round++) {
    let changed = false;
    for (const R of insts) {
      for (const src of R.sources) {
        const S = src.remote.inst;
        const out = src.remote.iface;
        for (const e of S.table.values()) {
          if (e.via.some((v) => v.iface === out.name)) continue; // split horizon
          let n = e.network;
          let p = e.prefix;
          const v1 = sends(S.cfg) === 1;
          if (p !== 0 && major(n).network !== major(out.address).network) {
            if (v1 || S.cfg.autoSummary) {
              n = major(n).network;
              p = major(n).prefix;
            }
          } else if (v1 && p !== 0 && p !== out.prefix) continue; // v1 carries no mask
          const hops = e.hops + 1;
          if (hops >= 16) continue;
          const k = key(n, p);
          const cur = R.table.get(k);
          const via = { iface: src.local.iface.name, nextHop: out.address };
          if (cur && cur.via.length === 0 && cur.hops === 0) continue;
          if (!cur || hops < cur.hops) {
            R.table.set(k, { network: n, prefix: p, hops, via: [via] });
            changed = true;
          } else if (hops === cur.hops && !cur.via.some((x) => x.nextHop === via.nextHop) && cur.via.length < 4) {
            cur.via.push(via);
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
      for (const v of e.via) {
        list.push({ code: 'R', network: e.network, prefix: e.prefix, distance: 120, metric: e.hops, nextHop: v.nextHop, iface: v.iface, isDefault: e.prefix === 0, source: 'rip', since: now });
      }
    }
    routes.set(R.dev.id, list);
  }
  return { instances: insts, routes };
}
