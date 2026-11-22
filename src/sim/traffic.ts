// Synthetic traffic and CPU load. Deterministic in (device, time), so graphs can be drawn
// for any past moment without storing history. Down links carry nothing.

import type { Network } from './network';
import type { Device } from './types';
import { isHostKind } from './types';

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** Smooth noise in [0, 1) that changes over roughly `period` ms. */
function smooth(key: string, t: number, period: number): number {
  const x = t / period;
  const i = Math.floor(x);
  const f = x - i;
  const a = hash(`${key}:${i}`);
  const b = hash(`${key}:${i + 1}`);
  const s = f * f * (3 - 2 * f);
  return a + (b - a) * s;
}

/** How busy a host is, in bits per second (download, upload). */
export function hostLoad(device: Device, t: number): { down: number; up: number } {
  const base = hash(device.id);
  const wobble = 0.4 + 0.6 * smooth(device.id, t, 45_000);
  let total: number;
  switch (device.kind) {
    case 'server':
      total = (6 + base * 18) * 1e6;
      break;
    case 'printer':
      total = (0.02 + 0.6 * smooth(`${device.id}:job`, t, 20_000) ** 4) * 1e6;
      break;
    default:
      total = (0.3 + base * 3.5) * 1e6;
  }
  total *= wobble;
  // Servers mostly send; workstations mostly receive.
  return device.kind === 'server' ? { down: total * 0.25, up: total * 0.75 } : { down: total * 0.7, up: total * 0.3 };
}

/** Hosts reachable through `fromDevice`'s interface (over up links), not going back through `fromDevice`. */
function hostsBehind(net: Network, fromDevice: string, startDevice: string): Device[] {
  const seen = new Set([fromDevice, startDevice]);
  const queue = [startDevice];
  const hosts: Device[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    const device = net.device(id);
    if (isHostKind(device.kind)) {
      hosts.push(device);
      continue;
    }
    for (const link of net.links) {
      const here = link.a.device === id ? link.a : link.b.device === id ? link.b : null;
      if (!here) continue;
      const there = here === link.a ? link.b : link.a;
      if (seen.has(there.device)) continue;
      if (!net.isUp(here.device, here.iface) || !net.isUp(there.device, there.iface)) continue;
      seen.add(there.device);
      queue.push(there.device);
    }
  }
  return hosts;
}

function internetShare(net: Network, t: number): { down: number; up: number } {
  let down = 0;
  let up = 0;
  for (const d of net.devices.values()) {
    if (d.managed && (d.kind === 'pc' || d.kind === 'server') && net.isOnline(d)) {
      const l = hostLoad(d, t);
      down += l.down * 0.35;
      up += l.up * 0.15;
    }
  }
  // Seen from the internet's side: what users upload flows toward it, what they download flows from it.
  return { down: up, up: down };
}

export interface Rates {
  /** Bits per second arriving on this interface. */
  inBps: number;
  outBps: number;
}

/** Traffic on a physical interface at time t. */
export function interfaceRates(net: Network, deviceId: string, iface: string, t = net.time): Rates {
  const peer = net.peerOf(deviceId, iface);
  if (!peer || !net.isUp(deviceId, iface) || !net.isUp(peer.device, peer.iface)) return { inBps: 0, outBps: 0 };
  const self = net.device(deviceId);
  if (isHostKind(self.kind)) {
    const l = self.managed ? hostLoad(self, t) : internetShare(net, t);
    return { inBps: l.down, outBps: l.up };
  }
  let down = 0;
  let up = 0;
  for (const h of hostsBehind(net, deviceId, peer.device)) {
    const l = h.managed ? hostLoad(h, t) : internetShare(net, t);
    down += l.down;
    up += l.up;
  }
  // "down" is traffic flowing toward those hosts, i.e. out of this interface.
  const cap = (net.device(deviceId).hardware[iface]?.maxSpeed ?? 1000) * 1e6;
  return { inBps: Math.min(up, cap), outBps: Math.min(down, cap) };
}

export function deviceCpu(net: Network, device: Device, t = net.time): number {
  if (!net.isOnline(device)) return 0;
  const base = { router: 7, l3switch: 11, switch: 4, pc: 3, server: 9, printer: 2 }[device.kind];
  return Math.round(base + 9 * smooth(`${device.id}:cpu`, t, 30_000) + 3 * hash(`${device.id}:${Math.floor(t / 5000)}`));
}

export function formatBps(bps: number): string {
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} kbps`;
  return `${Math.round(bps)} bps`;
}
