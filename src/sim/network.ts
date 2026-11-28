// The Network holds every device and cable, computes interface state (L1),
// VLAN/trunk forwarding (L2) and emits IOS-style console log messages when state changes.

import { cloneConfig, factoryConfig, MODELS } from './devices';
import { parentIfName, shortIfName } from './ifnames';
import { Rng } from './rng';
import type { Device, InterfaceConfig, InterfaceState, Link, LinkEnd } from './types';
import { isHostKind } from './types';
import type { Ipv4 } from './ip';
import { logStamp, syslogDelivered } from './mgmt';
import { computeBundles, computeStp, evaluatePortSecurity, syncVtp, type Bundle, type StpResult } from './l2';
import { logControlChanges } from './control';
import { daiRateViolations } from './security';
import { chooseBootImage } from './images';

export interface LogEntry {
  seq: number;
  device: string;
  time: number;
  /** Message without timestamp, e.g. "%LINK-3-UPDOWN: Interface ..., changed state to up" */
  message: string;
  /** The device's own timestamp for the line (its clock and `service timestamps` settings at the time). */
  stamp?: string;
  /** Did it reach the NOC's syslog collector? (Absent on older saves: treated as yes.) */
  collected?: boolean;
}

/** Sim time 0 is the true time at the start of the game. Devices without NTP keep their own (1993) clocks. */
const EPOCH = Date.UTC(2026, 3, 14, 8, 0, 0);

export const BOOT_TIME_MS = 45_000;

type OpMode = 'access' | 'trunk';

export class Network {
  readonly devices = new Map<string, Device>();
  readonly links: Link[] = [];
  readonly logs: LogEntry[] = [];
  /** Layer 2 results of the last commit (EtherChannel bundles, spanning tree). */
  bundles: Map<string, Bundle> = new Map();
  stp: StpResult = { vlans: new Map(), blocked: new Set(), bpduguard: [], storms: new Set() };
  /** Ports whose frames port security drops (restrict/protect). */
  private dropped = new Set<string>();
  private stormDomains = new Set<string>();
  private l2Events = new Set<string>();
  /** Bumped on every commit; routing protocol results are cached per version. */
  version = 0;
  /** Where devices' syslog has to arrive for the NOC to see it (the NOC PC). null = see everything. */
  syslogCollector: Ipv4 | null = null;
  readonly rng: Rng;
  time = 0;

  private states = new Map<string, InterfaceState>();
  private domains = new Map<string, string>();
  private logSeq = 0;

  constructor(seed: number | string = 1) {
    this.rng = new Rng(seed);
  }

  // ---- building the topology -------------------------------------------------

  addDevice(device: Device): Device {
    this.devices.set(device.id, device);
    return device;
  }

  connect(aDevice: string, aIface: string, bDevice: string, bIface: string): Link {
    for (const [dev, ifc] of [
      [aDevice, aIface],
      [bDevice, bIface],
    ]) {
      const device = this.device(dev);
      if (!device.hardware[ifc]) throw new Error(`${dev} has no port ${ifc}`);
      if (this.linkAt(dev, ifc)) throw new Error(`${dev} ${ifc} is already cabled`);
    }
    const link: Link = {
      id: `${aDevice}:${aIface}--${bDevice}:${bIface}`,
      a: { device: aDevice, iface: aIface },
      b: { device: bDevice, iface: bIface },
      cable: 'ok',
    };
    this.links.push(link);
    return link;
  }

  /** Unplugs whatever cable is in this port. */
  disconnect(deviceId: string, iface: string): void {
    const link = this.linkAt(deviceId, iface);
    if (link) this.links.splice(this.links.indexOf(link), 1);
  }

  device(id: string): Device {
    const d = this.devices.get(id);
    if (!d) throw new Error(`No device ${id}`);
    return d;
  }

  linkAt(deviceId: string, iface: string): Link | undefined {
    return this.links.find(
      (l) => (l.a.device === deviceId && l.a.iface === iface) || (l.b.device === deviceId && l.b.iface === iface),
    );
  }

  peerOf(deviceId: string, iface: string): LinkEnd | null {
    const link = this.linkAt(deviceId, iface);
    if (!link) return null;
    return link.a.device === deviceId && link.a.iface === iface ? link.b : link.a;
  }

  // ---- clock -----------------------------------------------------------------

  advance(ms: number): void {
    this.time += ms;
    this.countDuplexErrors(ms);
    for (const d of this.devices.values()) {
      if (d.reloadAt === undefined || this.time < d.reloadAt) continue;
      this.log(d.id, '%SYS-5-RELOAD: Reload requested by console. Reload Reason: Reload Command.');
      this.reload(d.id);
    }
    let changed = false;
    for (const device of this.devices.values()) {
      if (device.bootingUntil !== null && this.time >= device.bootingUntil) {
        device.bootingUntil = null;
        device.bootedAt = this.time;
        changed = true;
      }
    }
    if (changed) this.commit();
  }

  /** Link speed in Mb/s an Ethernet port runs at: its own setting, capped by the far end. null if no link. */
  negotiatedSpeed(deviceId: string, iface: string): number | null {
    const dev = this.device(deviceId);
    const hw = dev.hardware[iface];
    if (!hw || !this.isUp(deviceId, iface)) return null;
    const own = dev.running.interfaces[iface]?.speed;
    const mine = own === 'auto' || own === undefined ? hw.maxSpeed : own;
    const peer = this.peerOf(deviceId, iface);
    if (!peer) return mine;
    const pd = this.device(peer.device);
    const phw = pd.hardware[peer.iface];
    const ps = pd.running.interfaces[peer.iface]?.speed;
    const theirs = ps === 'auto' || ps === undefined ? (phw?.maxSpeed ?? mine) : ps;
    return Math.min(mine, theirs);
  }

  /**
   * Duplex a port runs at. A port with duplex hard-coded doesn't negotiate, so an auto port facing it can only sense
   * the speed and falls back to half duplex (Gigabit has no half duplex in practice, so it stays full).
   */
  negotiatedDuplex(deviceId: string, iface: string): 'full' | 'half' | null {
    const speed = this.negotiatedSpeed(deviceId, iface);
    if (speed === null) return null;
    const own = this.device(deviceId).running.interfaces[iface]?.duplex ?? 'auto';
    if (own !== 'auto') return own;
    const peer = this.peerOf(deviceId, iface);
    const theirs = peer ? (this.device(peer.device).running.interfaces[peer.iface]?.duplex ?? 'auto') : 'auto';
    return theirs === 'auto' || speed >= 1000 ? 'full' : 'half';
  }

  /** Both ends are up but disagree on duplex: the half side sees late collisions, the full side CRC errors and runts. */
  duplexMismatch(deviceId: string, iface: string): boolean {
    const peer = this.peerOf(deviceId, iface);
    if (!peer) return false;
    const mine = this.negotiatedDuplex(deviceId, iface);
    const theirs = this.negotiatedDuplex(peer.device, peer.iface);
    return mine !== null && theirs !== null && mine !== theirs;
  }

  /** Links running with a duplex mismatch (cached per version). */
  mismatchedLinks(): Link[] {
    if (this.mismatchCache?.version !== this.version) {
      this.mismatchCache = { version: this.version, links: this.links.filter((l) => this.duplexMismatch(l.a.device, l.a.iface)) };
    }
    return this.mismatchCache.links;
  }

  private mismatchCache: { version: number; links: Link[] } | null = null;

  /** Error counters climb on mismatched links; CDP between network devices complains once a minute. */
  private countDuplexErrors(ms: number): void {
    const sec = ms / 1000;
    for (const link of this.mismatchedLinks()) {
      for (const [end, other] of [
        [link.a, link.b],
        [link.b, link.a],
      ]) {
        const d = this.device(end.device);
        const c = ((d.ifCounters ??= {})[end.iface] ??= { crc: 0, runts: 0, lateCollisions: 0, collisions: 0, deferred: 0, since: this.time });
        const n = (lo: number, hi: number) => Math.round(this.rng.int(lo, hi) * sec);
        if (this.negotiatedDuplex(end.device, end.iface) === 'full') {
          c.crc += n(4, 14);
          c.runts += n(2, 9);
        } else {
          c.lateCollisions += n(2, 8);
          c.collisions += n(6, 20);
          c.deferred += n(1, 5);
        }
        const od = this.device(other.device);
        if (isHostKind(d.kind) || isHostKind(od.kind) || !this.isOnline(d)) continue;
        const logAt = (d.duplexLogAt ??= {});
        if (logAt[end.iface] !== undefined && this.time - logAt[end.iface] < 60000) continue;
        logAt[end.iface] = this.time;
        const theirs = this.negotiatedDuplex(other.device, other.iface);
        this.log(d.id, `%CDP-4-DUPLEX_MISMATCH: duplex mismatch discovered on ${end.iface} (not ${theirs} duplex), with ${od.running.hostname} ${other.iface} (${theirs} duplex).`);
      }
    }
  }

  /** `clear counters`: zero an interface's (or every interface's) error counters. */
  clearCounters(deviceId: string, iface?: string): void {
    const d = this.device(deviceId);
    if (!iface) d.ifCounters = {};
    else if (d.ifCounters) delete d.ifCounters[iface];
  }

  wallClock(time = this.time): Date {
    return new Date(EPOCH + time);
  }

  isOnline(device: Device): boolean {
    return device.powered && device.bootingUntil === null && !device.rommon;
  }

  /** Reboots a device: running config is replaced by startup config (or factory defaults). */
  reload(deviceId: string): void {
    const device = this.device(deviceId);
    device.running = device.startup ? cloneConfig(device.startup) : factoryConfig(MODELS[device.model]);
    device.bootingUntil = this.time + BOOT_TIME_MS;
    delete device.reloadAt;
    // Which NSOS image loads: boot system entries, then the first good image on flash, else ROMMON.
    if (device.images) {
      const boot = chooseBootImage(this, device);
      device.bootNotes = boot.messages;
      if (boot.image) {
        device.image = boot.image;
        device.rommon = false;
      } else device.rommon = true;
    }
    device.arp.clear();
    // A manually set clock doesn't survive a reload (there's no battery-backed calendar on these models).
    delete device.clockOffset;
    delete device.clockSetAt;
    this.commit();
  }

  // ---- state computation -----------------------------------------------------

  /**
   * Recomputes all interface and L2 state. Call after any config or physical change.
   * Emits console log messages for every interface whose state changed.
   */
  commit(options: { silent?: boolean } = {}): void {
    const previous = this.states;
    this.states = new Map();
    const events: string[] = [];
    for (const device of this.devices.values()) {
      for (const ifc of Object.values(device.running.interfaces)) {
        if (!ifc.name.startsWith('Vlan') && !ifc.name.startsWith('Port-channel')) this.states.set(key(device.id, ifc.name), this.computePhysical(device, ifc));
      }
    }
    // VLAN databases (VTP) depend on which trunks are up.
    syncVtp(this);
    // Port security can err-disable ports before anything is forwarded.
    const psec = evaluatePortSecurity(this);
    for (const ev of psec.events) {
      events.push(`${ev.device}|%PORT_SECURITY-2-PSECURE_VIOLATION: Security violation occurred, caused by MAC address ${ev.mac} on port ${ev.iface}.`);
      if (ev.shutdown) this.errDisable(ev.device, ev.iface, 'psecure-violation', events);
    }
    this.dropped = new Set([...psec.dropped].filter((k) => !this.devices.get(k.split('|')[0])?.errDisabled?.[k.split('|')[1]]));
    // EtherChannel: bundle members, then the port-channel interfaces.
    this.bundles = computeBundles(this);
    for (const b of this.bundles.values()) {
      for (const m of b.suspended) {
        const st = this.state(b.device, m);
        this.states.set(key(b.device, m), { ...st, protocol: 'down', suspended: true });
        events.push(`${b.device}|%EC-5-CANNOT_BUNDLE2: ${m} is not compatible with ${b.po} and will be suspended (vlan mask is different)`);
      }
      for (const m of b.bundled) events.push(`${b.device}|%EC-5-BUNDLE: Interface ${m} joined port-channel ${b.po}`);
      const po = this.device(b.device).running.interfaces[b.po];
      if (po) this.states.set(key(b.device, b.po), po.shutdown ? { link: 'admin-down', protocol: 'down' } : b.bundled.length ? { link: 'up', protocol: 'up' } : { link: 'down', protocol: 'down' });
    }
    for (const device of this.devices.values()) {
      for (const ifc of Object.values(device.running.interfaces)) {
        if (ifc.name.startsWith('Port-channel') && !this.states.has(key(device.id, ifc.name))) this.states.set(key(device.id, ifc.name), { link: ifc.shutdown ? 'admin-down' : 'down', protocol: 'down' });
      }
    }
    // SVIs depend on the state of the switchports in their VLAN.
    for (const device of this.devices.values()) {
      for (const ifc of Object.values(device.running.interfaces)) {
        if (ifc.name.startsWith('Vlan')) this.states.set(key(device.id, ifc.name), this.computeSvi(device, ifc));
      }
    }
    // Spanning tree; BPDU guard trips err-disable ports, which changes the tree once more.
    let stp = computeStp(this, this.bundles, this.dropped);
    if (stp.bpduguard.length) {
      for (const g of stp.bpduguard) {
        events.push(`${g.device}|%SPANTREE-2-BLOCK_BPDUGUARD: Received BPDU on port ${g.port} with BPDU Guard enabled. Disabling port.`);
        this.errDisable(g.device, g.port, 'bpduguard', events);
      }
      stp = computeStp(this, this.bundles, this.dropped);
    }
    this.stp = stp;
    for (const [vlan, bridges] of stp.vlans) {
      for (const b of bridges.values()) {
        for (const p of b.ports) {
          if (p.inconsistent === 'ROOT_Inc') events.push(`${b.device}|%SPANTREE-2-ROOTGUARD_BLOCK: Root guard blocking port ${p.name} on VLAN${String(vlan).padStart(4, '0')}.`);
          if (p.inconsistent === 'LOOP_Inc') events.push(`${b.device}|%SPANTREE-2-LOOPGUARD_BLOCK: Loop guard blocking port ${p.name} on VLAN${String(vlan).padStart(4, '0')}.`);
        }
      }
    }
    for (const s of stp.storms) {
      const [dev, vlan] = s.split('|');
      const d = this.device(dev);
      const up = Object.values(d.running.interfaces).filter((i) => i.switchport && d.hardware[i.name] && this.isUp(dev, i.name) && this.operationalMode(d, i) === 'trunk' && this.forwards(dev, i.name, Number(vlan)));
      // Prefer two forwarding trunks to the same neighbor: that's the loop.
      const byPeer = new Map<string, string[]>();
      for (const i of up) {
        const p = this.peerOf(dev, i.name)?.device ?? '';
        byPeer.set(p, [...(byPeer.get(p) ?? []), shortIfName(i.name)]);
      }
      const trunks = [...byPeer.values()].find((l) => l.length >= 2) ?? up.map((i) => shortIfName(i.name));
      if (trunks.length >= 2) events.push(`${dev}|%SW_MATM-4-MACFLAP_NOTIF: Host ${this.stormHostMac(dev, Number(vlan))} in vlan ${vlan} is flapping between port ${trunks[0]} and port ${trunks[1]}`);
    }
    this.computeDomains();
    // Log what's new since the last commit (IOS logs these once, when they happen).
    const fresh = new Set(events);
    for (const e of fresh) {
      if (this.l2Events.has(e)) continue;
      const i = e.indexOf('|');
      this.log(e.slice(0, i), e.slice(i + 1));
    }
    this.l2Events = new Set([...fresh].filter((e) => !e.includes('%PM-4-ERR_DISABLE') && !e.includes('BLOCK_BPDUGUARD')));
    this.expireArp();
    this.version++;
    this.vlanFilterCache = null;
    if (!options.silent) {
      this.emitStateLogs(previous);
      logControlChanges(this);
    }
    // Dynamic ARP inspection rate limits: an untrusted port facing a whole floor's ARP gets err-disabled.
    const dai = daiRateViolations(this);
    if (dai.length) {
      const ev: string[] = [];
      for (const v of dai) {
        ev.push(`${v.device}|%SW_DAI-4-PACKET_RATE_EXCEEDED: ${v.pps} packets received in 1000 milliseconds on ${shortIfName(v.iface)}.`);
        this.errDisable(v.device, v.iface, 'arp-inspection', ev);
      }
      for (const e of ev) {
        const i = e.indexOf('|');
        this.log(e.slice(0, i), e.slice(i + 1));
      }
      this.commit(options);
    }
  }

  private vlanFilterCache: Device[] | null = null;

  /** Switches with a `vlan filter` applied (so packet walks can skip the VLAN map check when there are none). */
  devicesWithVlanFilters(): Device[] {
    this.vlanFilterCache ??= [...this.devices.values()].filter((d) => d.running.vlanFilters?.length);
    return this.vlanFilterCache;
  }

  state(deviceId: string, iface: string): InterfaceState {
    return this.states.get(key(deviceId, iface)) ?? { link: 'down', protocol: 'down' };
  }

  isUp(deviceId: string, iface: string): boolean {
    return this.state(deviceId, iface).protocol === 'up';
  }

  /** A host's adapter only passes traffic with a working, enabled driver. */
  nicWorking(device: Device): boolean {
    return !device.nic || (device.nic.driver === 'ok' && !device.nic.disabled && !device.nic.failed);
  }

  private physicalLinkUp(device: Device, ifc: InterfaceConfig): boolean {
    if (!this.isOnline(device) || ifc.shutdown || !this.nicWorking(device)) return false;
    const link = this.linkAt(device.id, ifc.name);
    if (!link || link.cable !== 'ok') return false;
    if (device.deadPorts?.includes(ifc.name)) return false;
    const peerEnd = link.a.device === device.id ? link.b : link.a;
    const peer = this.device(peerEnd.device);
    const peerIfc = peer.running.interfaces[peerEnd.iface];
    if (!this.isOnline(peer) || !peerIfc || peerIfc.shutdown || !this.nicWorking(peer)) return false;
    if (peer.deadPorts?.includes(peerEnd.iface)) return false;
    // Two hard-coded, different speeds never come up.
    if (ifc.speed !== 'auto' && peerIfc.speed !== 'auto' && ifc.speed !== peerIfc.speed) return false;
    return true;
  }

  private computePhysical(device: Device, ifc: InterfaceConfig): InterfaceState {
    if (ifc.shutdown) return { link: 'admin-down', protocol: 'down' };
    if (!this.isOnline(device)) return { link: 'down', protocol: 'down' };
    const err = device.errDisabled?.[ifc.name];
    if (err) return { link: 'down', protocol: 'down', err: err.cause };
    if (ifc.name.startsWith('Loopback')) return { link: 'up', protocol: 'up' };
    const parent = parentIfName(ifc.name);
    if (parent) {
      const parentCfg = device.running.interfaces[parent];
      if (!parentCfg) return { link: 'down', protocol: 'down' };
      if (parentCfg.shutdown) return { link: 'admin-down', protocol: 'down' };
      const up = this.physicalLinkUp(device, parentCfg);
      return { link: up ? 'up' : 'down', protocol: up ? 'up' : 'down' };
    }
    const up = this.physicalLinkUp(device, ifc);
    return { link: up ? 'up' : 'down', protocol: up ? 'up' : 'down' };
  }

  private computeSvi(device: Device, ifc: InterfaceConfig): InterfaceState {
    if (ifc.shutdown) return { link: 'admin-down', protocol: 'down' };
    if (!this.isOnline(device)) return { link: 'down', protocol: 'down' };
    const vlan = Number(ifc.name.slice(4));
    if (!device.vlans[vlan]) return { link: 'down', protocol: 'down' };
    const active = Object.values(device.running.interfaces).some((port) => {
      if (!port.switchport || !this.isUp(device.id, port.name)) return false;
      return this.vlansCarried(device, port).includes(vlan);
    });
    return { link: 'up', protocol: active ? 'up' : 'down' };
  }

  // ---- switching (L2) --------------------------------------------------------

  /** Operational switchport mode after DTP negotiation. */
  operationalMode(device: Device, ifc: InterfaceConfig): OpMode {
    const sp = ifc.switchport;
    if (!sp) return 'access';
    if (sp.mode === 'access' || sp.mode === 'trunk') return sp.mode;
    const peerEnd = this.peerOf(device.id, ifc.name);
    if (!peerEnd) return 'access';
    const peer = this.device(peerEnd.device);
    const peerSp = peer.running.interfaces[peerEnd.iface]?.switchport;
    if (!peerSp) return 'access';
    const peerWantsTrunk = peerSp.mode === 'trunk' || peerSp.mode === 'dynamic desirable';
    if (sp.mode === 'dynamic desirable') return peerSp.mode !== 'access' ? 'trunk' : 'access';
    return peerWantsTrunk ? 'trunk' : 'access';
  }

  /** VLANs (that exist in the VLAN database) this switchport forwards. */
  vlansCarried(device: Device, ifc: InterfaceConfig): number[] {
    const sp = ifc.switchport;
    if (!sp) return [];
    if (this.operationalMode(device, ifc) === 'access') return device.vlans[sp.accessVlan] ? [sp.accessVlan] : [];
    return Object.keys(device.vlans)
      .map(Number)
      .filter((v) => v < 1002 && (sp.allowedVlans === 'all' || sp.allowedVlans.includes(v)));
  }

  /**
   * Which frames a port sends/receives: 'u' = untagged, 't10' = tagged VLAN 10.
   * Maps each channel to the internal node it connects to.
   */
  channels(device: Device, ifc: InterfaceConfig): Map<string, string> {
    const result = new Map<string, string>();
    if (ifc.switchport) {
      const sp = ifc.switchport;
      if (this.operationalMode(device, ifc) === 'access') {
        if (device.vlans[sp.accessVlan] && this.forwards(device.id, ifc.name, sp.accessVlan)) result.set('u', vlanNode(device.id, sp.accessVlan));
        return result;
      }
      // ISL tags every VLAN (it has no native VLAN); 802.1Q sends the native VLAN untagged.
      // An ISL end and a dot1Q end share no channels, so a mismatched trunk passes nothing.
      const isl = device.kind === 'l3switch' && sp.trunkEncapsulation === 'isl';
      for (const vlan of this.vlansCarried(device, ifc)) {
        if (!this.forwards(device.id, ifc.name, vlan)) continue;
        result.set(isl ? `i${vlan}` : vlan === sp.nativeVlan ? 'u' : `t${vlan}`, vlanNode(device.id, vlan));
      }
      return result;
    }
    // Routed port: untagged frames go to the interface itself, tagged ones to its subinterfaces.
    result.set('u', ifNode(device.id, ifc.name));
    for (const sub of Object.values(device.running.interfaces)) {
      if (parentIfName(sub.name) !== ifc.name || !sub.encapsulation || !this.isUp(device.id, sub.name)) continue;
      const e = sub.encapsulation;
      result.set(e.type === 'isl' ? `i${e.vlan}` : e.native ? 'u' : `t${e.vlan}`, ifNode(device.id, sub.name));
    }
    return result;
  }

  private computeDomains(): void {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let root = x;
      while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
      parent.set(x, root);
      return root;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    for (const link of this.links) {
      if (!this.isUp(link.a.device, link.a.iface) || !this.isUp(link.b.device, link.b.iface)) continue;
      const da = this.device(link.a.device);
      const db = this.device(link.b.device);
      const ca = this.channels(da, da.running.interfaces[link.a.iface]);
      const cb = this.channels(db, db.running.interfaces[link.b.iface]);
      for (const [channel, nodeA] of ca) {
        const nodeB = cb.get(channel);
        if (nodeB) union(nodeA, nodeB);
      }
    }
    for (const device of this.devices.values()) {
      for (const ifc of Object.values(device.running.interfaces)) {
        if (ifc.name.startsWith('Vlan') && this.isUp(device.id, ifc.name)) {
          union(ifNode(device.id, ifc.name), vlanNode(device.id, Number(ifc.name.slice(4))));
        }
      }
    }
    this.domains = new Map();
    for (const node of parent.keys()) this.domains.set(node, find(node));
    this.stormDomains = new Set();
    for (const s of this.stp.storms) {
      const [dev, vlan] = s.split('|');
      this.stormDomains.add(find(vlanNode(dev, Number(vlan))));
    }
  }

  /** Is this broadcast domain melting down in a broadcast storm? */
  isStorming(domain: string): boolean {
    return this.stormDomains.has(domain);
  }

  /** Puts a port in err-disable (port security, BPDU guard). */
  errDisable(deviceId: string, iface: string, cause: string, events: string[]): void {
    const d = this.device(deviceId);
    if (d.errDisabled?.[iface]) return;
    (d.errDisabled ??= {})[iface] = { cause, at: this.time };
    events.push(`${deviceId}|%PM-4-ERR_DISABLE: ${cause} error detected on ${shortIfName(iface)}, putting ${shortIfName(iface)} in err-disable state`);
    this.states.set(key(deviceId, iface), { link: 'down', protocol: 'down', err: cause });
  }

  /** `errdisable recovery`: re-enables ports whose cause has recovery on, after the interval. Call each tick. */
  recoverErrDisabled(): void {
    let changed = false;
    for (const d of this.devices.values()) {
      const cfg = d.running.errdisable;
      if (!cfg || !d.errDisabled) continue;
      for (const [iface, e] of Object.entries(d.errDisabled)) {
        if (!(cfg.causes.includes('all') || cfg.causes.includes(e.cause))) continue;
        if (this.time - e.at < cfg.interval * 1000) continue;
        delete d.errDisabled[iface];
        this.log(d.id, `%PM-4-ERR_RECOVER: Attempting to recover from ${e.cause} err-disable state on ${shortIfName(iface)}`);
        changed = true;
      }
    }
    if (changed) this.commit();
  }

  private stormHostMac(deviceId: string, vlan: number): string {
    const d = this.device(deviceId);
    for (const ifc of Object.values(d.running.interfaces)) {
      if (ifc.switchport?.accessVlan !== vlan) continue;
      const peer = this.peerOf(deviceId, ifc.name);
      if (peer) return this.device(peer.device).hardware[peer.iface]?.mac ?? d.baseMac;
    }
    return d.baseMac;
  }

  /** Does this switchport forward frames for this VLAN (not STP-blocked, suspended or dropped)? */
  forwards(deviceId: string, iface: string, vlan: number): boolean {
    if (this.stp.blocked.has(`${deviceId}|${iface}|${vlan}`)) return false;
    if (this.dropped.has(`${deviceId}|${iface}`)) return false;
    return !this.state(deviceId, iface).suspended;
  }

  /** Broadcast domain ID of an L3 interface (routed port, subinterface, SVI or host NIC). */
  domainOf(deviceId: string, iface: string): string {
    const node = ifNode(deviceId, iface);
    return this.domains.get(node) ?? node;
  }

  private expireArp(): void {
    for (const device of this.devices.values()) {
      for (const [ip, entry] of device.arp) {
        if (!this.isUp(device.id, entry.iface)) device.arp.delete(ip);
      }
    }
  }

  // ---- logging ---------------------------------------------------------------

  log(deviceId: string, message: string): void {
    const device = this.devices.get(deviceId);
    const entry: LogEntry = { seq: ++this.logSeq, device: deviceId, time: this.time, message };
    if (device) {
      entry.stamp = logStamp(this, device, this.time);
      if (this.syslogCollector !== null) entry.collected = syslogDelivered(this, device, message, this.syslogCollector);
    }
    this.logs.push(entry);
    if (this.logs.length > 5000) this.logs.splice(0, 1000);
  }

  logsSince(deviceId: string, seq: number): LogEntry[] {
    return this.logs.filter((l) => l.device === deviceId && l.seq > seq);
  }

  /** Everything needed to restore the network exactly (for saved games). */
  exportState(): NetworkState {
    return {
      devices: [...this.devices.values()].map((d) => ({ ...structuredClone({ ...d, arp: undefined }), arp: [...d.arp.entries()] })),
      links: structuredClone(this.links),
      time: this.time,
      logs: this.logs.slice(-1500),
      logSeq: this.logSeq,
      rng: this.rng.seedState,
    };
  }

  importState(state: NetworkState): void {
    this.devices.clear();
    for (const d of state.devices) {
      const { arp, ...rest } = d;
      this.devices.set(d.id, { ...(rest as unknown as Device), arp: new Map(arp) });
    }
    this.links.splice(0, this.links.length, ...state.links);
    this.logs.splice(0, this.logs.length, ...state.logs);
    this.time = state.time;
    this.logSeq = state.logSeq;
    this.rng.seedState = state.rng;
    this.states = new Map();
    this.commit({ silent: true });
  }

  get lastLogSeq(): number {
    return this.logSeq;
  }

  private emitStateLogs(previous: Map<string, InterfaceState>): void {
    for (const [k, now] of this.states) {
      const before = previous.get(k);
      const [deviceId, iface] = splitKey(k);
      const device = this.device(deviceId);
      if (!this.isOnline(device) || isHostKind(device.kind)) continue;
      if (parentIfName(iface)) continue; // IOS does not log subinterface transitions here
      if (!before) {
        // A newly created interface (Loopback, SVI) announces itself if it comes up.
        if (now.link === 'up') this.log(deviceId, `%LINK-3-UPDOWN: Interface ${iface}, changed state to up`);
        if (now.protocol === 'up') this.logProto(deviceId, iface, 'up');
        continue;
      }
      if (before.link !== now.link) {
        if (now.link === 'admin-down') {
          this.log(deviceId, `%LINK-5-CHANGED: Interface ${iface}, changed state to administratively down`);
        } else {
          this.log(deviceId, `%LINK-3-UPDOWN: Interface ${iface}, changed state to ${now.link}`);
        }
      }
      if (before.protocol !== now.protocol) this.logProto(deviceId, iface, now.protocol);
    }
  }

  private logProto(deviceId: string, iface: string, state: string): void {
    this.log(deviceId, `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${iface}, changed state to ${state}`);
  }

  /** "*Mar  1 00:02:13.420: " - the asterisk means the clock is not NTP-synchronized. */
  formatLogTime(time: number): string {
    const d = this.wallClock(time);
    const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const day = String(d.getUTCDate()).padStart(2, ' ');
    const hms = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, '0'));
    const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
    return `*${month} ${day} ${hms.join(':')}.${ms}`;
  }

  /** Short label used by humans and tests: "SW1 Fa0/1". */
  describe(deviceId: string, iface: string): string {
    return `${this.device(deviceId).running.hostname} ${shortIfName(iface)}`;
  }
}

export interface NetworkState {
  devices: (Omit<Device, 'arp'> & { arp: [number, Device['arp'] extends Map<number, infer V> ? V : never][] })[];
  links: Link[];
  time: number;
  logs: LogEntry[];
  logSeq: number;
  rng: number;
}

export function key(deviceId: string, iface: string): string {
  return `${deviceId}|${iface}`;
}

function splitKey(k: string): [string, string] {
  const i = k.indexOf('|');
  return [k.slice(0, i), k.slice(i + 1)];
}

function ifNode(deviceId: string, iface: string): string {
  return `if|${deviceId}|${iface}`;
}

function vlanNode(deviceId: string, vlan: number): string {
  return `vlan|${deviceId}|${vlan}`;
}

