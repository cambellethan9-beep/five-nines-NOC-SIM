// The MAC address table of a switch: every station in a VLAN that frames can reach from this switch, and the port
// that leads to it. Computed from the live L2 state (trunks, VLANs, spanning tree, EtherChannel), like the rest of
// the sim, rather than learned frame by frame. After `clear mac address-table dynamic` stations reappear as they talk.

import { shortIfName, parentIfName } from './ifnames';
import type { Network } from './network';
import type { Device } from './types';

export interface MacEntry {
  vlan: number;
  mac: string;
  port: string;
  /** Full name of the port (the port-channel for a bundled member). */
  iface: string;
  type: 'DYNAMIC' | 'STATIC';
}

/** Reserved addresses the switch CPU listens on (spanning tree, CDP/VTP/DTP, PVST+). */
const CPU_MACS = ['0100.0ccc.cccc', '0100.0ccc.cccd', '0180.c200.0000', '0180.c200.0001', '0180.c200.0002', '0180.c200.0003'];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function macOfNode(net: Network, node: string): string | null {
  const [kind, dev, iface] = node.split('|');
  if (kind !== 'if') return null;
  const d = net.device(dev);
  if (iface.startsWith('Vlan')) return d.baseMac;
  return d.hardware[parentIfName(iface) ?? iface]?.mac ?? d.baseMac;
}

function portName(net: Network, d: Device, iface: string): string {
  for (const b of net.bundles.values()) if (b.device === d.id && b.bundled.includes(iface)) return b.po;
  return iface;
}

const cache = new WeakMap<Network, { version: number; tables: Map<string, MacEntry[]> }>();

/** Every station's port on this switch, from live L2 state (cached until the network changes). */
export function rawMacTable(net: Network, deviceId: string): MacEntry[] {
  let c = cache.get(net);
  if (!c || c.version !== net.version) {
    c = { version: net.version, tables: new Map() };
    cache.set(net, c);
  }
  let t = c.tables.get(deviceId);
  if (!t) {
    t = computeMacTable(net, deviceId);
    c.tables.set(deviceId, t);
  }
  return t;
}

function computeMacTable(net: Network, deviceId: string): MacEntry[] {
  const d = net.device(deviceId);
  const entries: MacEntry[] = [];
  const seen = new Set<string>();
  for (const vlan of Object.keys(d.vlans).map(Number).filter((v) => v < 1002).sort((a, b) => a - b)) {
    const start = `vlan|${deviceId}|${vlan}`;
    const visited = new Set<string>([start]);
    for (const ifc of Object.values(d.running.interfaces)) {
      if (!ifc.switchport || !d.hardware[ifc.name] || !net.isUp(deviceId, ifc.name)) continue;
      const link = net.linkAt(deviceId, ifc.name);
      if (!link) continue;
      const full = portName(net, d, ifc.name);
      const port = shortIfName(full);
      for (const [channel, node] of net.channels(d, ifc)) {
        if (node !== start) continue;
        const peer = link.a.device === deviceId ? link.b : link.a;
        const pd = net.device(peer.device);
        const pifc = pd.running.interfaces[peer.iface];
        if (!pifc || !net.isUp(peer.device, peer.iface)) continue;
        const next = net.channels(pd, pifc).get(channel);
        if (!next) continue;
        // Walk outward from the far end and collect every station.
        const queue: { node: string; via: string }[] = [{ node: next, via: link.id }];
        while (queue.length) {
          const { node, via } = queue.shift()!;
          if (visited.has(node)) continue;
          visited.add(node);
          const mac = macOfNode(net, node);
          if (mac) {
            const k = `${vlan}|${mac}`;
            if (!seen.has(k)) {
              seen.add(k);
              const psec = ifc.portSecurity?.enabled && (ifc.portSecurity.stickyMacs.includes(mac) || ifc.portSecurity.macs.includes(mac));
              entries.push({ vlan, mac, port, iface: full, type: psec ? 'STATIC' : 'DYNAMIC' });
            }
            continue;
          }
          const [, dev, v] = node.split('|');
          const sw = net.device(dev);
          const svi = sw.running.interfaces[`Vlan${v}`];
          if (svi && net.isUp(dev, svi.name)) queue.push({ node: `if|${dev}|${svi.name}`, via });
          for (const p of Object.values(sw.running.interfaces)) {
            if (!p.switchport || !sw.hardware[p.name] || !net.isUp(dev, p.name)) continue;
            const l = net.linkAt(dev, p.name);
            if (!l || l.id === via) continue;
            const far = l.a.device === dev ? l.b : l.a;
            const fd = net.device(far.device);
            const fifc = fd.running.interfaces[far.iface];
            if (!fifc || !net.isUp(far.device, far.iface)) continue;
            const fch = net.channels(fd, fifc);
            for (const [c, n] of net.channels(sw, p)) {
              if (n !== node) continue;
              const nn = fch.get(c);
              if (nn) queue.push({ node: nn, via: l.id });
            }
          }
        }
      }
    }
  }
  return entries.sort((a, b) => a.vlan - b.vlan || a.mac.localeCompare(b.mac));
}

export function macTable(net: Network, deviceId: string): MacEntry[] {
  const entries = rawMacTable(net, deviceId);
  // After a flush, stations come back as they send traffic (chatty PCs within seconds, quiet printers later).
  const cleared = net.device(deviceId).macClearedAt;
  return cleared === undefined ? entries : entries.filter((e) => e.type === 'STATIC' || net.time - cleared >= (hash(e.mac) % 40) * 1000 + 2000);
}

export interface MacFilter {
  dynamic?: boolean;
  static?: boolean;
  address?: string;
  iface?: string;
  vlan?: number;
}

export function showMacTable(net: Network, d: Device, f: MacFilter = {}): string[] {
  let rows = macTable(net, d.id);
  if (f.address) rows = rows.filter((r) => r.mac === f.address);
  if (f.iface) rows = rows.filter((r) => r.port === shortIfName(f.iface!));
  if (f.vlan !== undefined) rows = rows.filter((r) => r.vlan === f.vlan);
  if (f.static) rows = rows.filter((r) => r.type === 'STATIC');
  if (f.dynamic) rows = rows.filter((r) => r.type === 'DYNAMIC');
  const cpu = !f.dynamic && !f.address && !f.iface && f.vlan === undefined ? CPU_MACS : [];
  const lines = ['          Mac Address Table', '-------------------------------------------', '', 'Vlan    Mac Address       Type        Ports', '----    -----------       --------    -----'];
  for (const m of cpu) lines.push(` All    ${m}    STATIC      CPU`);
  for (const r of rows) lines.push(`${String(r.vlan).padStart(4)}    ${r.mac}    ${r.type.padEnd(12)}${r.port}`);
  lines.push(`Total Mac Addresses for this criterion: ${rows.length + cpu.length}`);
  return lines;
}

export function showMacCount(net: Network, d: Device): string[] {
  const rows = macTable(net, d.id);
  const lines: string[] = [];
  for (const vlan of Object.keys(d.vlans).map(Number).filter((v) => v < 1002).sort((a, b) => a - b)) {
    const dyn = rows.filter((r) => r.vlan === vlan && r.type === 'DYNAMIC').length;
    const st = rows.filter((r) => r.vlan === vlan && r.type === 'STATIC').length;
    lines.push(`Mac Entries for Vlan ${vlan}:`, '---------------------------', `Dynamic Address Count  : ${dyn}`, `Static  Address Count  : ${st}`, `Total Mac Addresses    : ${dyn + st}`, '');
  }
  lines.push(`Total Mac Address Space Available: ${8000 - rows.length - CPU_MACS.length}`, '');
  return lines;
}
