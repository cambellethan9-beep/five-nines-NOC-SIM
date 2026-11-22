// Configuration for dynamic routing protocols (what `show running-config` shows under `router ...`).

import type { Ipv4 } from '../ip';

export type RedistSource = 'connected' | 'static' | 'ospf' | 'eigrp' | 'rip' | 'bgp';

export interface Redistribute {
  source: RedistSource;
  /** OSPF process id, EIGRP AS or BGP AS of the source. */
  id?: number;
  /** OSPF: [metric]; RIP: [hops]; EIGRP: [bandwidth, delay, reliability, load, mtu]. */
  metric?: number[];
  metricType?: 1 | 2;
  /** OSPF only: without it, only classful networks are redistributed. */
  subnets?: boolean;
}

export interface PassiveConfig {
  passiveDefault: boolean;
  /** With passiveDefault false: interfaces made passive; with true: interfaces made active (`no passive-interface`). */
  exceptions: string[];
}

export interface OspfProcess {
  pid: number;
  routerId: Ipv4 | null;
  networks: { addr: Ipv4; wildcard: Ipv4; area: number }[];
  passive: PassiveConfig;
  defaultOriginate: { always: boolean; metric?: number; metricType?: 1 | 2 } | null;
  redistribute: Redistribute[];
  areas: Record<number, { stub: boolean; noSummary: boolean }>;
  /** `auto-cost reference-bandwidth` in Mbps. */
  refBw: number;
}

export interface EigrpProcess {
  asn: number;
  /** Set for named mode (`router eigrp NAME` / `address-family ipv4 unicast autonomous-system N`). */
  name?: string;
  routerId: Ipv4 | null;
  /** wildcard null = classful `network A`. */
  networks: { addr: Ipv4; wildcard: Ipv4 | null }[];
  passive: PassiveConfig;
  /** K1..K5. */
  k: [number, number, number, number, number];
  autoSummary: boolean;
  redistribute: Redistribute[];
  defaultMetric: number[] | null;
}

export interface RipConfig {
  version: 1 | 2 | null;
  /** Classful network numbers. */
  networks: Ipv4[];
  passive: PassiveConfig;
  autoSummary: boolean;
  defaultOriginate: boolean;
  redistribute: Redistribute[];
  defaultMetric: number | null;
}

export interface BgpNeighbor {
  remoteAs: number;
  description?: string;
  shutdown?: boolean;
  ebgpMultihop?: number;
  nextHopSelf?: boolean;
  defaultOriginate?: boolean;
  updateSource?: string;
}

export interface BgpConfig {
  asn: number;
  routerId: Ipv4 | null;
  /** Keyed by the neighbor address in dotted form. */
  neighbors: Record<string, BgpNeighbor>;
  networks: { addr: Ipv4; prefix: number }[];
  redistribute: Redistribute[];
}

export interface RoutingConfig {
  ospf: OspfProcess[];
  eigrp: EigrpProcess[];
  rip: RipConfig | null;
  bgp: BgpConfig | null;
}

/** Per-interface OSPF settings (`ip ospf ...`). */
export interface InterfaceOspf {
  cost?: number;
  hello?: number;
  dead?: number;
  priority?: number;
  network?: 'broadcast' | 'point-to-point';
  area?: { pid: number; area: number };
  mtuIgnore?: boolean;
  auth?: 'simple' | 'md5' | 'null';
  authKey?: string;
  mdKeys?: Record<number, string>;
}

export function emptyRouting(): RoutingConfig {
  return { ospf: [], eigrp: [], rip: null, bgp: null };
}

export function newOspf(pid: number): OspfProcess {
  return { pid, routerId: null, networks: [], passive: { passiveDefault: false, exceptions: [] }, defaultOriginate: null, redistribute: [], areas: {}, refBw: 100 };
}

export function newEigrp(asn: number, name?: string): EigrpProcess {
  return {
    asn,
    ...(name ? { name } : {}),
    routerId: null,
    networks: [],
    passive: { passiveDefault: false, exceptions: [] },
    k: [1, 0, 1, 0, 0],
    autoSummary: false,
    redistribute: [],
    defaultMetric: null,
  };
}

export function newRip(): RipConfig {
  return { version: null, networks: [], passive: { passiveDefault: false, exceptions: [] }, autoSummary: true, defaultOriginate: false, redistribute: [], defaultMetric: null };
}

export function newBgp(asn: number): BgpConfig {
  return { asn, routerId: null, neighbors: {}, networks: [], redistribute: [] };
}

export function isPassive(p: PassiveConfig, iface: string): boolean {
  return p.passiveDefault ? !p.exceptions.includes(iface) : p.exceptions.includes(iface);
}

/** "0" -> 0, "0.0.0.1" -> 1 (OSPF area IDs). */
export function parseArea(text: string): number | null {
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n <= 4294967295 ? n : null;
  }
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
