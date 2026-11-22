// BGP-4 basics: sessions (matching neighbor statements and AS numbers, eBGP directly connected unless
// ebgp-multihop, TCP 179 not filtered), `network` statements that need an exact RIB match, redistribution,
// default-originate, AS-path loop prevention, the iBGP split-horizon rule, and best-path selection.

import { inSubnet, networkOf, parseIp, type Ipv4 } from '../ip';
import type { Network } from '../network';
import type { Route } from '../routing';
import type { Device } from '../types';
import { protocolPermitted, upInterfaces, type RIface } from './common';
import type { BgpConfig } from './config';
import { matchesSource } from './ospf';

export interface BgpPath {
  network: Ipv4;
  prefix: number;
  nextHop: Ipv4; // 0 = locally originated
  asPath: number[];
  origin: 'i' | '?';
  from: Ipv4 | null;
  ibgp: boolean;
  best?: boolean;
  /** iBGP next hop not resolvable. */
  inaccessible?: boolean;
}

export interface BgpSession {
  peer: Ipv4;
  remoteAs: number;
  state: 'Established' | 'Active' | 'Idle (Admin)' | 'Idle';
  localAddr: Ipv4 | null;
  prefixesReceived: number;
}

export interface BgpInstance {
  dev: Device;
  cfg: BgpConfig;
  rid: Ipv4;
  sessions: BgpSession[];
  paths: BgpPath[];
}

export interface BgpResult {
  instances: BgpInstance[];
  routes: Map<string, Route[]>;
}

const key = (n: Ipv4, p: number) => `${n}/${p}`;

function localAddrFor(net: Network, d: Device, peer: Ipv4, updateSource?: string): RIface | null {
  const ifs = upInterfaces(net, d);
  if (updateSource) return ifs.find((i) => i.name === updateSource) ?? null;
  return ifs.find((i) => inSubnet(peer, i.address, i.prefix)) ?? ifs[0] ?? null;
}

export function computeBgp(net: Network, devices: Device[], rib: Map<string, Route[]>, now: number): BgpResult {
  const insts: BgpInstance[] = [];
  for (const d of devices) {
    const cfg = d.running.routing?.bgp;
    if (!cfg) continue;
    const ifs = upInterfaces(net, d);
    const rid = cfg.routerId ?? ifs.reduce((m, i) => Math.max(m, i.address), 0);
    insts.push({ dev: d, cfg, rid, sessions: [], paths: [] });
  }
  const owner = (ip: Ipv4) => insts.find((i) => upInterfaces(net, i.dev).some((x) => x.address === ip));
  const routable = (d: Device, ip: Ipv4) => (rib.get(d.id) ?? []).some((r) => r.code !== 'B' && inSubnet(ip, r.network, r.prefix));

  // Sessions.
  const links: { a: BgpInstance; b: BgpInstance; sa: BgpSession; ebgp: boolean; aAddr: Ipv4; bAddr: Ipv4 }[] = [];
  for (const A of insts) {
    for (const [peerText, n] of Object.entries(A.cfg.neighbors)) {
      const peer = parseIp(peerText)!;
      const local = localAddrFor(net, A.dev, peer, n.updateSource);
      const s: BgpSession = { peer, remoteAs: n.remoteAs, state: n.shutdown ? 'Idle (Admin)' : 'Active', localAddr: local?.address ?? null, prefixesReceived: 0 };
      A.sessions.push(s);
      if (n.shutdown || !local) continue;
      const B = owner(peer);
      if (!B || B.cfg.asn !== n.remoteAs) continue;
      const back = B.cfg.neighbors[[local.address >>> 24, (local.address >>> 16) & 255, (local.address >>> 8) & 255, local.address & 255].join('.')];
      if (!back || back.shutdown || back.remoteAs !== A.cfg.asn) continue;
      const ebgp = A.cfg.asn !== B.cfg.asn;
      const bIf = upInterfaces(net, B.dev).find((x) => x.address === peer)!;
      const direct = inSubnet(peer, local.address, local.prefix);
      if (ebgp && !direct && !(n.ebgpMultihop && back.ebgpMultihop)) continue;
      if (direct) {
        if (net.domainOf(A.dev.id, local.name) !== net.domainOf(B.dev.id, bIf.name)) continue;
        if (!protocolPermitted(local, bIf, { proto: 'tcp', dstPort: 179, srcPort: 30000 }, peer) || !protocolPermitted(bIf, local, { proto: 'tcp', srcPort: 179, dstPort: 30000, established: true }, local.address)) continue;
      } else if (!routable(A.dev, peer) || !routable(B.dev, local.address)) continue;
      s.state = 'Established';
      links.push({ a: A, b: B, sa: s, ebgp, aAddr: local.address, bAddr: peer });
    }
  }

  // Locally originated paths.
  for (const I of insts) {
    const table = rib.get(I.dev.id) ?? [];
    for (const n of I.cfg.networks) {
      if (table.some((r) => r.code !== 'B' && r.network === n.addr && r.prefix === n.prefix)) {
        I.paths.push({ network: n.addr, prefix: n.prefix, nextHop: 0, asPath: [], origin: 'i', from: null, ibgp: false });
      }
    }
    for (const r of I.cfg.redistribute) {
      for (const t of table.filter((x) => matchesSource(x, r.source, r.id) && x.code !== 'B')) {
        if (!I.paths.some((p) => p.network === t.network && p.prefix === t.prefix && p.nextHop === 0)) {
          I.paths.push({ network: t.network, prefix: t.prefix, nextHop: 0, asPath: [], origin: '?', from: null, ibgp: false });
        }
      }
    }
  }

  const pickBest = (I: BgpInstance) => {
    const groups = new Map<string, BgpPath[]>();
    for (const p of I.paths) {
      p.best = false;
      p.inaccessible = p.ibgp && p.nextHop !== 0 && !routable(I.dev, p.nextHop);
      const k = key(p.network, p.prefix);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(p);
    }
    for (const g of groups.values()) {
      const ok = g.filter((p) => !p.inaccessible);
      ok.sort((x, y) => (x.nextHop === 0 ? -1 : 0) - (y.nextHop === 0 ? -1 : 0) || x.asPath.length - y.asPath.length || Number(x.ibgp) - Number(y.ibgp) || (x.from ?? 0) - (y.from ?? 0));
      if (ok[0]) ok[0].best = true;
    }
  };

  // Propagate until stable.
  for (let round = 0; round < 8; round++) {
    let changed = false;
    insts.forEach(pickBest);
    for (const L of links) {
      for (const [S, R, sAddr, rAddr, ebgp] of [
        [L.a, L.b, L.aAddr, L.bAddr, L.ebgp],
        [L.b, L.a, L.bAddr, L.aAddr, L.ebgp],
      ] as const) {
        const nb = S.cfg.neighbors[[rAddr >>> 24, (rAddr >>> 16) & 255, (rAddr >>> 8) & 255, rAddr & 255].join('.')];
        const offers: BgpPath[] = [];
        for (const p of S.paths.filter((x) => x.best)) {
          if (!ebgp && p.ibgp) continue; // routes from one iBGP peer aren't passed to another
          offers.push({
            ...p,
            asPath: ebgp ? [S.cfg.asn, ...p.asPath] : p.asPath,
            nextHop: ebgp || nb?.nextHopSelf || p.nextHop === 0 ? sAddr : p.nextHop,
          });
        }
        if (nb?.defaultOriginate) offers.push({ network: 0, prefix: 0, nextHop: sAddr, asPath: ebgp ? [S.cfg.asn] : [], origin: 'i', from: null, ibgp: false });
        for (const o of offers) {
          if (o.asPath.includes(R.cfg.asn)) continue; // loop prevention
          const path: BgpPath = { ...o, from: sAddr, ibgp: !ebgp, best: false };
          const exists = R.paths.find((p) => p.from === sAddr && p.network === o.network && p.prefix === o.prefix);
          if (exists) {
            if (exists.asPath.join() !== path.asPath.join() || exists.nextHop !== path.nextHop) {
              Object.assign(exists, path);
              changed = true;
            }
          } else {
            R.paths.push(path);
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
  insts.forEach(pickBest);
  for (const I of insts) {
    for (const s of I.sessions) s.prefixesReceived = I.paths.filter((p) => p.from === s.peer).length;
  }

  const routes = new Map<string, Route[]>();
  for (const I of insts) {
    const list: Route[] = [];
    const conn = upInterfaces(net, I.dev);
    for (const p of I.paths) {
      if (!p.best || p.nextHop === 0) continue;
      const direct = conn.find((i) => inSubnet(p.nextHop, i.address, i.prefix));
      list.push({
        code: 'B',
        network: p.network,
        prefix: p.prefix,
        distance: p.ibgp ? 200 : 20,
        metric: 0,
        nextHop: p.nextHop,
        iface: direct && !p.ibgp ? direct.name : null,
        isDefault: p.prefix === 0,
        source: `bgp ${I.cfg.asn}`,
        since: now,
      });
    }
    routes.set(I.dev.id, list);
    void networkOf;
  }
  return { instances: insts, routes };
}
