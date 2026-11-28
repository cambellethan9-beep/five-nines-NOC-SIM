// Layer 2 control: VTP, port security, EtherChannel bundling and spanning tree (PVST+), plus broadcast-storm
// detection. Runs inside Network.commit() between interface state and broadcast-domain computation.

import type { Network } from './network';
import type { ChannelMode, Device, InterfaceConfig, SwitchStp, VtpConfig } from './types';
import { isHostKind, isSwitchKind } from './types';

export const DEFAULT_STP: SwitchStp = {
  mode: 'pvst',
  priorities: [],
  disabled: [],
  portfastDefault: false,
  bpduguardDefault: false,
  bpdufilterDefault: false,
  loopguardDefault: false,
};
export const DEFAULT_VTP: VtpConfig = { mode: 'server', domain: null, password: null, version: 1 };

export const stpOf = (d: Device): SwitchStp => d.running.stp ?? DEFAULT_STP;
export const vtpOf = (d: Device): VtpConfig => d.running.vtp ?? DEFAULT_VTP;

/** Bridge priority for a VLAN (the last matching `spanning-tree vlan ... priority` wins). */
export function bridgePriority(d: Device, vlan: number): number {
  let p = 32768;
  for (const e of stpOf(d).priorities) if (e.vlans.includes(vlan)) p = e.priority;
  return p;
}

// ---------------------------------------------------------------- VTP

/** Copies the VLAN database of the highest-revision server/client to its VTP neighbors (the revision wipe). */
export function syncVtp(net: Network): void {
  const switches = [...net.devices.values()].filter((d) => isSwitchKind(d.kind) && net.isOnline(d));
  // Groups: switches linked by operational trunks; transparent switches pass adverts through, `off` blocks them.
  const parent = new Map<string, string>();
  const find = (x: string): string => (parent.get(x) === x || !parent.has(x) ? x : find(parent.get(x)!));
  for (const d of switches) parent.set(d.id, d.id);
  for (const link of net.links) {
    const a = net.device(link.a.device);
    const b = net.device(link.b.device);
    if (!isSwitchKind(a.kind) || !isSwitchKind(b.kind) || !net.isUp(a.id, link.a.iface) || !net.isUp(b.id, link.b.iface)) continue;
    const ia = a.running.interfaces[link.a.iface];
    const ib = b.running.interfaces[link.b.iface];
    if (!ia?.switchport || !ib?.switchport || net.operationalMode(a, ia) !== 'trunk' || net.operationalMode(b, ib) !== 'trunk') continue;
    if (vtpOf(a).mode === 'off' || vtpOf(b).mode === 'off') continue;
    parent.set(find(a.id), find(b.id));
  }
  const groups = new Map<string, Device[]>();
  for (const d of switches) {
    const r = find(d.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(d);
  }
  for (const g of groups.values()) {
    // Within a group, only same-domain/password/version server and client switches exchange VLANs.
    const players = g.filter((d) => {
      const v = vtpOf(d);
      return (v.mode === 'server' || v.mode === 'client') && v.domain !== null;
    });
    const byDomain = new Map<string, Device[]>();
    for (const d of players) {
      const v = vtpOf(d);
      const k = `${v.domain}|${v.password ?? ''}|${v.version}`;
      if (!byDomain.has(k)) byDomain.set(k, []);
      byDomain.get(k)!.push(d);
    }
    for (const members of byDomain.values()) {
      const best = members.reduce((m, d) => ((d.vtpRevision ?? 0) > (m.vtpRevision ?? 0) ? d : m), members[0]);
      for (const d of members) {
        if (d === best || (d.vtpRevision ?? 0) === (best.vtpRevision ?? 0)) continue;
        d.vlans = structuredClone(best.vlans);
        d.vtpRevision = best.vtpRevision ?? 0;
      }
    }
  }
}

// ---------------------------------------------------------------- port security

/** MAC addresses that would show up on a switch port (the host behind it, or "many" behind another switch). */
function macsBehind(net: Network, d: Device, port: string): string[] | 'many' {
  const peer = net.peerOf(d.id, port);
  if (!peer) return [];
  const pd = net.device(peer.device);
  if (isHostKind(pd.kind)) return [pd.hardware[peer.iface]?.mac ?? pd.baseMac];
  if (isSwitchKind(pd.kind)) return 'many';
  return [pd.hardware[peer.iface.split('.')[0]]?.mac ?? pd.baseMac];
}

export interface PsecEvent {
  device: string;
  iface: string;
  mac: string;
  shutdown: boolean;
}

/** Learns MACs, makes them sticky, and reports violations (the caller err-disables or drops). */
export function evaluatePortSecurity(net: Network): { events: PsecEvent[]; dropped: Set<string> } {
  const events: PsecEvent[] = [];
  const dropped = new Set<string>();
  for (const d of net.devices.values()) {
    if (!isSwitchKind(d.kind) || !net.isOnline(d)) continue;
    for (const ifc of Object.values(d.running.interfaces)) {
      const ps = ifc.portSecurity;
      if (!ps?.enabled || !ifc.switchport || !net.isUp(d.id, ifc.name)) continue;
      const seen = macsBehind(net, d, ifc.name);
      const learned = ((d.psecLearned ??= {})[ifc.name] ??= []);
      const secure = () => [...ps.macs, ...ps.stickyMacs, ...learned];
      const list = seen === 'many' ? ['ffff.0000.0001', 'ffff.0000.0002', 'ffff.0000.0003'] : seen;
      for (const mac of list) {
        if (secure().includes(mac)) continue;
        if (secure().length < ps.max) {
          if (ps.sticky) ps.stickyMacs.push(mac);
          else learned.push(mac);
          continue;
        }
        const v = ((d.psecViolations ??= {})[ifc.name] ??= { count: 0, lastMac: mac });
        v.count++;
        v.lastMac = mac;
        if (ps.violation !== 'protect') events.push({ device: d.id, iface: ifc.name, mac, shutdown: ps.violation === 'shutdown' });
        dropped.add(`${d.id}|${ifc.name}`);
        break;
      }
    }
  }
  return { events, dropped };
}

// ---------------------------------------------------------------- EtherChannel

export interface Bundle {
  device: string;
  po: string;
  mode: ChannelMode;
  bundled: string[];
  suspended: string[];
  standalone: string[];
  down: string[];
}

function protocolOf(m: ChannelMode): 'LACP' | 'PAgP' | '-' {
  return m === 'active' || m === 'passive' ? 'LACP' : m === 'desirable' || m === 'auto' ? 'PAgP' : '-';
}

/** Do two member modes form a channel? (on-on; LACP needs an active end; PAgP needs a desirable end.) */
export function modesPair(a: ChannelMode, b: ChannelMode): boolean {
  if (a === 'on' || b === 'on') return a === 'on' && b === 'on';
  if (protocolOf(a) !== protocolOf(b)) return false;
  if (protocolOf(a) === 'LACP') return a === 'active' || b === 'active';
  return a === 'desirable' || b === 'desirable';
}

const spKey = (i: InterfaceConfig | undefined) => JSON.stringify({ ...(i?.switchport ?? {}), speed: i?.speed, duplex: i?.duplex });

export function computeBundles(net: Network): Map<string, Bundle> {
  const bundles = new Map<string, Bundle>();
  for (const d of net.devices.values()) {
    if (!net.isOnline(d)) continue;
    for (const ifc of Object.values(d.running.interfaces)) {
      const cg = ifc.channelGroup;
      if (!cg) continue;
      const po = `Port-channel${cg.id}`;
      const k = `${d.id}|${po}`;
      if (!bundles.has(k)) bundles.set(k, { device: d.id, po, mode: cg.mode, bundled: [], suspended: [], standalone: [], down: [] });
      const b = bundles.get(k)!;
      if (!net.isUp(d.id, ifc.name)) {
        b.down.push(ifc.name);
        continue;
      }
      const poCfg = d.running.interfaces[po];
      // Members must match the port-channel's switchport settings and speed/duplex.
      if (poCfg && spKey({ ...poCfg, speed: ifc.speed, duplex: ifc.duplex }) !== spKey(ifc)) {
        b.suspended.push(ifc.name);
        continue;
      }
      const peer = net.peerOf(d.id, ifc.name);
      const pd = peer ? net.device(peer.device) : null;
      const pcg = pd?.running.interfaces[peer!.iface]?.channelGroup;
      if (!pcg) {
        // LACP/PAgP with no partner: the port runs on its own. `on` bundles blindly.
        (cg.mode === 'on' ? b.bundled : b.standalone).push(ifc.name);
        continue;
      }
      if (!modesPair(cg.mode, pcg.mode)) {
        (cg.mode === 'on' || pcg.mode === 'on' ? b.suspended : b.standalone).push(ifc.name);
        continue;
      }
      b.bundled.push(ifc.name);
    }
  }
  // Members of one bundle must all reach the same neighbor bundle; otherwise the odd ones are suspended.
  for (const b of bundles.values()) {
    const targets = b.bundled.map((m) => {
      const p = net.peerOf(b.device, m);
      const pcg = p ? net.device(p.device).running.interfaces[p.iface]?.channelGroup : undefined;
      return p ? `${p.device}|${pcg?.id ?? '-'}` : '-';
    });
    const first = targets[0];
    for (let i = b.bundled.length - 1; i >= 0; i--) {
      if (targets[i] !== first) b.suspended.push(...b.bundled.splice(i, 1));
    }
  }
  return bundles;
}

// ---------------------------------------------------------------- spanning tree

export interface StpPort {
  name: string;
  role: 'Root' | 'Desg' | 'Altn' | 'Disabled';
  state: 'FWD' | 'BLK';
  cost: number;
  prio: number;
  num: number;
  edge: boolean;
  inconsistent?: 'ROOT_Inc' | 'LOOP_Inc' | 'PVID_Inc';
}

export interface StpBridge {
  device: string;
  priority: number;
  mac: string;
  rootPriority: number;
  rootMac: string;
  rootDevice: string;
  rootCost: number;
  rootPort: string | null;
  ports: StpPort[];
}

export interface StpResult {
  /** vlan -> device -> bridge info. */
  vlans: Map<number, Map<string, StpBridge>>;
  /** "device|port|vlan" for ports that don't forward (ports are member names for bundles). */
  blocked: Set<string>;
  /** Ports that received a BPDU with BPDU guard on. */
  bpduguard: { device: string; port: string }[];
  /** "device|vlan" for switches inside a forwarding loop. */
  storms: Set<string>;
}

const portCost = (mbps: number) => (mbps >= 10000 ? 2 : mbps >= 2000 ? 3 : mbps >= 1000 ? 4 : mbps >= 200 ? 12 : mbps >= 100 ? 19 : 100);

interface SPort {
  device: Device;
  name: string; // Port-channel name for bundles
  members: string[];
  cost: number;
  num: number;
  prio: number;
  cfg: InterfaceConfig;
  peer: { device: Device; port: string } | null;
}

const bidLess = (pa: number, ma: string, pb: number, mb: string) => pa < pb || (pa === pb && ma < mb);

export function computeStp(net: Network, bundles: Map<string, Bundle>, dropped: Set<string>): StpResult {
  const result: StpResult = { vlans: new Map(), blocked: new Set(), bpduguard: [], storms: new Set() };
  const switches = [...net.devices.values()].filter((d) => isSwitchKind(d.kind) && net.isOnline(d));
  const memberToPo = new Map<string, string>();
  for (const b of bundles.values()) for (const m of b.bundled) memberToPo.set(`${b.device}|${m}`, b.po);
  const hwIndex = (d: Device, name: string) => Object.keys(d.hardware).indexOf(name) + 1;

  const allVlans = new Set<number>();
  for (const d of switches) for (const v of Object.keys(d.vlans).map(Number)) if (v < 1002) allVlans.add(v);

  for (const vlan of allVlans) {
    // Ports of each switch that carry this VLAN (bundles collapse into their port-channel).
    const ports: SPort[] = [];
    for (const d of switches) {
      if (!d.vlans[vlan]) continue;
      const seenPo = new Set<string>();
      for (const ifc of Object.values(d.running.interfaces)) {
        if (!ifc.switchport || !d.hardware[ifc.name] || !net.isUp(d.id, ifc.name)) continue;
        if (dropped.has(`${d.id}|${ifc.name}`)) continue;
        if (ifc.channelGroup && !memberToPo.has(`${d.id}|${ifc.name}`) && net.state(d.id, ifc.name).suspended) continue;
        if (!net.vlansCarried(d, ifc).includes(vlan)) continue;
        const po = memberToPo.get(`${d.id}|${ifc.name}`);
        if (po) {
          if (seenPo.has(po)) continue;
          seenPo.add(po);
          const b = bundles.get(`${d.id}|${po}`)!;
          const speed = b.bundled.reduce((s, m) => s + (net.negotiatedSpeed(d.id, m) ?? 0), 0);
          const pcfg = d.running.interfaces[po] ?? ifc;
          const peer = net.peerOf(d.id, b.bundled[0]);
          ports.push({ device: d, name: po, members: b.bundled, cost: pcfg.stp?.cost ?? portCost(speed), num: 64 + Number(po.slice(12)), prio: pcfg.stp?.priority ?? 128, cfg: pcfg, peer: peer ? { device: net.device(peer.device), port: memberToPo.get(`${peer.device}|${peer.iface}`) ?? peer.iface } : null });
          continue;
        }
        const peer = net.peerOf(d.id, ifc.name);
        ports.push({
          device: d,
          name: ifc.name,
          members: [ifc.name],
          cost: ifc.stp?.cost ?? portCost(net.negotiatedSpeed(d.id, ifc.name) ?? 100),
          num: hwIndex(d, ifc.name),
          prio: ifc.stp?.priority ?? 128,
          cfg: ifc,
          peer: peer ? { device: net.device(peer.device), port: peer.iface } : null,
        });
      }
    }
    const byKey = new Map(ports.map((p) => [`${p.device.id}|${p.name}`, p]));
    const runs = (d: Device) => !stpOf(d).disabled.includes(vlan);
    const portfast = (p: SPort) => {
      const pf = p.cfg.stp?.portfast;
      if (pf === 'disable') return false;
      if (pf === 'enable' || pf === 'trunk') return true;
      return stpOf(p.device).portfastDefault && net.operationalMode(p.device, p.cfg) === 'access';
    };
    const filters = (p: SPort) => {
      const f = p.cfg.stp?.bpdufilter;
      if (f) return f === 'enable';
      return stpOf(p.device).bpdufilterDefault && portfast(p);
    };
    const guardsBpdu = (p: SPort) => {
      const g = p.cfg.stp?.bpduguard;
      if (g) return g === 'enable';
      return stpOf(p.device).bpduguardDefault && portfast(p);
    };
    const loopGuard = (p: SPort) => (p.cfg.stp?.guard ? p.cfg.stp.guard === 'loop' : stpOf(p.device).loopguardDefault);
    const sendsBpdu = (p: SPort) => runs(p.device) && !filters(p);
    const peerPort = (p: SPort) => (p.peer ? byKey.get(`${p.peer.device.id}|${p.peer.port}`) ?? null : null);

    // BPDU guard: a BPDU arriving on a guarded port err-disables it.
    for (const p of ports) {
      const q = peerPort(p);
      if (q && sendsBpdu(q) && guardsBpdu(p) && !filters(p)) result.bpduguard.push({ device: p.device.id, port: p.members[0] });
    }

    // STP segments: links where both ends speak spanning tree for this VLAN.
    const segs: [SPort, SPort][] = [];
    for (const p of ports) {
      const q = peerPort(p);
      if (q && p.device.id < q.device.id && sendsBpdu(p) && sendsBpdu(q)) segs.push([p, q]);
    }
    const bid = (d: Device) => ({ prio: bridgePriority(d, vlan) + vlan, mac: d.baseMac });

    const solve = (excluded: Set<SPort>) => {
      const bridges = switches.filter((d) => d.vlans[vlan] && runs(d));
      const live = segs.filter(([p, q]) => !excluded.has(p) && !excluded.has(q));
      // Root per connected component: lowest bridge ID.
      const comp = new Map<string, string>(bridges.map((d) => [d.id, d.id]));
      const findC = (x: string): string => (comp.get(x) === x ? x : findC(comp.get(x)!));
      for (const [p, q] of live) comp.set(findC(p.device.id), findC(q.device.id));
      const roots = new Map<string, Device>();
      for (const d of bridges) {
        const c = findC(d.id);
        const cur = roots.get(c);
        if (!cur || bidLess(bid(d).prio, bid(d).mac, bid(cur).prio, bid(cur).mac)) roots.set(c, d);
      }
      // Root path cost (Dijkstra over segments; cost of the receiving port).
      const dist = new Map<string, number>();
      for (const r of roots.values()) dist.set(r.id, 0);
      const done = new Set<string>();
      for (;;) {
        let best: string | null = null;
        for (const [k, v] of dist) if (!done.has(k) && (best === null || v < dist.get(best)!)) best = k;
        if (best === null) break;
        done.add(best);
        for (const [p, q] of live) {
          for (const [a, b] of [
            [p, q],
            [q, p],
          ] as const) {
            if (a.device.id !== best) continue;
            const nd = dist.get(best)! + b.cost;
            if (!dist.has(b.device.id) || nd < dist.get(b.device.id)!) dist.set(b.device.id, nd);
          }
        }
      }
      return { live, findC, roots, dist };
    };

    // Root guard: a guarded port that would hear a better root goes root-inconsistent.
    // PVST+ checks the native VLAN on 802.1Q trunks: if the two ends disagree, both native VLANs are blocked on that
    // link (port VLAN ID inconsistent) until they match.
    const native = (p: SPort) => (p.cfg.switchport && net.operationalMode(p.device, p.cfg) === 'trunk' && p.cfg.switchport.trunkEncapsulation !== 'isl' ? p.cfg.switchport.nativeVlan : null);
    const pvid = new Set<SPort>();
    for (const p of ports) {
      const q = peerPort(p);
      if (!q || !sendsBpdu(p) || !sendsBpdu(q)) continue;
      const a = native(p);
      const b = native(q);
      if (a !== null && b !== null && a !== b && (vlan === a || vlan === b)) pvid.add(p);
    }
    const rootGuarded = ports.filter((p) => p.cfg.stp?.guard === 'root' && !pvid.has(p));
    const first = solve(new Set([...rootGuarded, ...pvid]));
    const inconsistent = new Map<SPort, 'ROOT_Inc' | 'LOOP_Inc' | 'PVID_Inc'>();
    for (const p of pvid) inconsistent.set(p, 'PVID_Inc');
    for (const p of rootGuarded) {
      if (inconsistent.has(p)) continue;
      const q = peerPort(p);
      if (!q || !sendsBpdu(q) || !sendsBpdu(p)) continue;
      const mine = first.roots.get(first.findC(p.device.id));
      const theirs = first.roots.get(first.findC(q.device.id));
      if (mine && theirs && bidLess(bid(theirs).prio, bid(theirs).mac, bid(mine).prio, bid(mine).mac)) inconsistent.set(p, 'ROOT_Inc');
    }
    const final = solve(new Set(inconsistent.keys()));

    const info = new Map<string, StpBridge>();
    for (const d of switches) {
      if (!d.vlans[vlan] || !runs(d)) continue;
      const root = final.roots.get(final.findC(d.id))!;
      info.set(d.id, {
        device: d.id,
        priority: bid(d).prio,
        mac: d.baseMac,
        rootPriority: bid(root).prio,
        rootMac: root.baseMac,
        rootDevice: root.id,
        rootCost: final.dist.get(d.id) ?? 0,
        rootPort: null,
        ports: [],
      });
    }
    // Root ports.
    for (const [id, b] of info) {
      if (b.rootDevice === id) continue;
      let bestPort: SPort | null = null;
      let bestKey: (string | number)[] | null = null;
      for (const [p, q] of final.live) {
        for (const [mine, other] of [
          [p, q],
          [q, p],
        ] as const) {
          if (mine.device.id !== id) continue;
          const key = [(final.dist.get(other.device.id) ?? 0) + mine.cost, bid(other.device).prio, other.device.baseMac, other.prio * 1000 + other.num, mine.prio * 1000 + mine.num];
          if (!bestKey || compareKeys(key, bestKey) < 0) {
            bestKey = key;
            bestPort = mine;
          }
        }
      }
      b.rootPort = bestPort?.name ?? null;
    }
    // Port roles.
    const designated = new Set<SPort>();
    for (const [p, q] of final.live) {
      const kp = [final.dist.get(p.device.id) ?? 0, bid(p.device).prio, p.device.baseMac, p.prio * 1000 + p.num];
      const kq = [final.dist.get(q.device.id) ?? 0, bid(q.device).prio, q.device.baseMac, q.prio * 1000 + q.num];
      designated.add(compareKeys(kp, kq) <= 0 ? p : q);
    }
    const inLive = new Set(final.live.flat());
    for (const p of ports) {
      const b = info.get(p.device.id);
      let role: StpPort['role'] = 'Desg';
      let state: StpPort['state'] = 'FWD';
      let inc = inconsistent.get(p);
      const q = peerPort(p);
      if (!runs(p.device)) {
        role = 'Desg';
      } else if (inc) {
        state = 'BLK';
      } else if (inLive.has(p)) {
        if (b?.rootPort === p.name) role = 'Root';
        else if (!designated.has(p)) {
          role = 'Altn';
          state = 'BLK';
        }
      } else if (q && runs(q.device) && !sendsBpdu(q) && !filters(p) && loopGuard(p)) {
        // A switch neighbor that has gone silent: loop guard holds the port instead of forwarding.
        inc = 'LOOP_Inc';
        state = 'BLK';
      }
      if (state === 'BLK') for (const m of p.members) result.blocked.add(`${p.device.id}|${m}|${vlan}`);
      b?.ports.push({ name: p.name, role, state, cost: p.cost, prio: p.prio, num: p.num, edge: portfast(p) && (!q || isHostKind(q.device.kind) || q.device.kind === 'router'), inconsistent: inc });
    }
    for (const b of info.values()) b.ports.sort((x, y) => x.num - y.num);
    result.vlans.set(vlan, info);

    // Storms: forwarding switch-to-switch links that close a loop.
    const parent = new Map<string, string>();
    const find = (x: string): string => (parent.get(x) === undefined || parent.get(x) === x ? x : find(parent.get(x)!));
    const loopRoots = new Set<string>();
    const fwd = (p: SPort) => !result.blocked.has(`${p.device.id}|${p.members[0]}|${vlan}`);
    for (const p of ports) {
      const q = peerPort(p);
      if (!q || p.device.id >= q.device.id || !fwd(p) || !fwd(q)) continue;
      const a = find(p.device.id);
      const c = find(q.device.id);
      if (a === c) loopRoots.add(a);
      else parent.set(a, c);
    }
    if (loopRoots.size) {
      for (const d of switches) {
        if (!d.vlans[vlan]) continue;
        const r = find(d.id);
        if ([...loopRoots].some((x) => find(x) === r)) result.storms.add(`${d.id}|${vlan}`);
      }
    }
  }
  return result;
}

function compareKeys(a: (string | number)[], b: (string | number)[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}
