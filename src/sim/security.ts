// Layer 2 security: DHCP snooping (trusted ports, bindings, option 82), dynamic ARP inspection (bindings, ARP ACLs,
// rate limits), IP source guard, port ACLs (an IP ACL inbound on a switchport) and VLAN access maps. Like the rest
// of the sim it judges state, not packets: which switches sit between two stations is read off their MAC tables.

import { evaluate, type Packet } from './acl';
import { formatIp, type Ipv4 } from './ip';
import { rawMacTable, type MacEntry } from './mactable';
import type { Network } from './network';
import { formatVlanList } from './render';
import { l3Interfaces, macOf } from './routing';
import type { Device, SnoopBinding } from './types';
import { isHostKind, isSwitchKind } from './types';

export interface End {
  device: string;
  iface: string;
}

interface OnPath {
  sw: Device;
  vlan: number;
  /** The port on `sw` toward each end (null when the end is the switch itself, e.g. its SVI). */
  toA: MacEntry | null;
  toB: MacEntry | null;
}

function endMac(net: Network, e: End): string {
  return macOf(net.device(e.device), e.iface);
}

export function endIp(net: Network, e: End): Ipv4 | null {
  return l3Interfaces(net, net.device(e.device)).find((i) => i.name === e.iface)?.address ?? null;
}

/** Switches a frame between two stations passes through, with the port toward each. */
export function switchesBetween(net: Network, a: End, b: End): OnPath[] {
  const out: OnPath[] = [];
  const macA = endMac(net, a);
  const macB = endMac(net, b);
  for (const sw of net.devices.values()) {
    if (!isSwitchKind(sw.kind) || !net.isOnline(sw)) continue;
    const localA = a.device === sw.id;
    const localB = b.device === sw.id;
    if (localA && localB) continue;
    const table = rawMacTable(net, sw.id);
    const sviVlan = (e: End) => (e.iface.startsWith('Vlan') ? Number(e.iface.slice(4)) : null);
    let vlan: number | null = localA ? sviVlan(a) : localB ? sviVlan(b) : null;
    let ea: MacEntry | undefined;
    let eb: MacEntry | undefined;
    if (vlan !== null) {
      ea = localA ? undefined : table.find((x) => x.vlan === vlan && x.mac === macA);
      eb = localB ? undefined : table.find((x) => x.vlan === vlan && x.mac === macB);
    } else {
      for (const x of table) {
        if (x.mac !== macA) continue;
        const y = table.find((z) => z.vlan === x.vlan && z.mac === macB);
        if (y) {
          ea = x;
          eb = y;
          vlan = x.vlan;
          break;
        }
      }
    }
    if (vlan === null) continue;
    if ((!localA && !ea) || (!localB && !eb)) continue;
    if (ea && eb && ea.iface === eb.iface) continue;
    out.push({ sw, vlan, toA: ea ?? null, toB: eb ?? null });
  }
  return out;
}

const snoopOn = (sw: Device, vlan: number) => !!sw.running.snooping?.enabled && sw.running.snooping.vlans.includes(vlan);
const daiOn = (sw: Device, vlan: number) => !!sw.running.dai?.vlans.includes(vlan) && !!sw.running.snooping?.enabled;
const trusted = (sw: Device, e: MacEntry, kind: 'snoop' | 'dai') => !!sw.running.interfaces[e.iface]?.[kind === 'snoop' ? 'snoopTrust' : 'daiTrust'];

// ---- DHCP snooping ------------------------------------------------------------------------------

export type DhcpPath = { ok: true; option82: boolean; bindAt: { sw: Device; vlan: number; iface: string }[] } | { ok: false; at: Device; iface: string };

/** A DHCP exchange between a client and a server (or the relay interface). Snooping drops server replies on untrusted ports. */
export function dhcpPath(net: Network, client: End, server: End): DhcpPath {
  const bindAt: { sw: Device; vlan: number; iface: string }[] = [];
  let option82 = false;
  for (const p of switchesBetween(net, client, server)) {
    if (!snoopOn(p.sw, p.vlan)) continue;
    if (p.toB && !trusted(p.sw, p.toB, 'snoop')) return { ok: false, at: p.sw, iface: p.toB.iface };
    if (p.toA && !trusted(p.sw, p.toA, 'snoop')) {
      bindAt.push({ sw: p.sw, vlan: p.vlan, iface: p.toA.iface });
      if (p.sw.running.snooping!.option82) option82 = true;
    }
  }
  return { ok: true, option82, bindAt };
}

/** Does the relay accept requests carrying option 82 with a zero giaddr (inserted by a snooping switch)? */
export function relayAcceptsOption82(relay: Device, iface: string): boolean {
  return !!relay.running.relayTrustAll || !!relay.running.interfaces[iface]?.relayInfoTrusted;
}

export function recordBindings(net: Network, path: Extract<DhcpPath, { ok: true }>, mac: string, ip: Ipv4, leaseMs: number | null | undefined): void {
  for (const b of path.bindAt) {
    const binds = (b.sw.snoopBindings ??= {});
    binds[mac] = { mac, ip, vlan: b.vlan, iface: b.iface, expires: net.time + (leaseMs ?? 8 * 86400000) };
  }
}

/** Bindings (DHCP-learned and static) a switch trusts for a station. */
function bound(net: Network, sw: Device, mac: string, ip: Ipv4 | null, vlan: number): boolean {
  if (ip === null) return false;
  const dyn = sw.snoopBindings?.[mac];
  if (dyn && dyn.ip === ip && dyn.vlan === vlan && dyn.expires > net.time) return true;
  return (sw.running.sourceBindings ?? []).some((s) => s.mac === mac && s.ip === ip && s.vlan === vlan);
}

// ---- dynamic ARP inspection --------------------------------------------------------------------

/** ARP ACL verdict for a sender: 'permit', 'deny' (explicit) or null (no match). */
function arpAclVerdict(sw: Device, vlan: number, mac: string, ip: Ipv4 | null): { verdict: 'permit' | 'deny' | null; isStatic: boolean } {
  for (const f of sw.running.dai?.filters ?? []) {
    if (!f.vlans.includes(vlan)) continue;
    for (const e of sw.running.arpAcls?.[f.acl] ?? []) {
      if (e.ip !== null && e.ip !== ip) continue;
      if (e.mac !== null && e.mac !== mac) continue;
      return { verdict: e.action, isStatic: f.static };
    }
    if (f.static) return { verdict: 'deny', isStatic: true };
  }
  return { verdict: null, isStatic: false };
}

function stamp(net: Network): string {
  const d = net.wallClock();
  return `${[d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, '0')).join(':')} UTC ${d.toUTCString().slice(0, 3)} ${d.toUTCString().slice(8, 11)} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}

const lastLog = new WeakMap<Network, Map<string, number>>();
function logOnce(net: Network, key: string, device: string, msg: string): void {
  let m = lastLog.get(net);
  if (!m) lastLog.set(net, (m = new Map()));
  const at = m.get(key);
  if (at !== undefined && net.time - at < 60000 && at <= net.time) return;
  m.set(key, net.time);
  net.log(device, msg);
}

/** Can these two stations exchange ARP? DAI drops ARPs on untrusted ports that match no binding or ARP ACL. */
export function arpAllowed(net: Network, a: End, b: End, log = true): boolean {
  if (![...net.devices.values()].some((d) => d.running.dai?.vlans.length)) return true;
  for (const p of switchesBetween(net, a, b)) {
    if (!daiOn(p.sw, p.vlan)) continue;
    for (const [end, port, other] of [
      [a, p.toA, b],
      [b, p.toB, a],
    ] as const) {
      if (!port || trusted(p.sw, port, 'dai')) continue;
      const mac = endMac(net, end);
      const ip = endIp(net, end);
      const acl = arpAclVerdict(p.sw, p.vlan, mac, ip);
      if (acl.verdict === 'permit') continue;
      if (acl.verdict !== 'deny' && bound(net, p.sw, mac, ip, p.vlan)) continue;
      if (log) {
        const kind = acl.verdict === 'deny' ? 'ACL_DENY' : 'DHCP_SNOOPING_DENY';
        const target = endIp(net, other);
        logOnce(
          net,
          `${p.sw.id}|${mac}`,
          p.sw.id,
          `%SW_DAI-4-${kind}: 1 Invalid ARPs (Req) on ${port.port}, vlan ${p.vlan}.([${mac}/${ip === null ? '0.0.0.0' : formatIp(ip)}/0000.0000.0000/${target === null ? '0.0.0.0' : formatIp(target)}/${stamp(net)}])`,
        );
        p.sw.daiDrops = (p.sw.daiDrops ?? 0) + 1;
      }
      return false;
    }
  }
  return true;
}

/** Untrusted DAI ports facing more ARP than their rate limit (an uplink left untrusted). */
export function daiRateViolations(net: Network): { device: string; iface: string; pps: number }[] {
  const out: { device: string; iface: string; pps: number }[] = [];
  for (const sw of net.devices.values()) {
    const dai = sw.running.dai;
    if (!dai?.vlans.length || !sw.running.snooping?.enabled || !net.isOnline(sw)) continue;
    const counts = new Map<string, number>();
    for (const e of rawMacTable(net, sw.id)) if (dai.vlans.includes(e.vlan)) counts.set(e.iface, (counts.get(e.iface) ?? 0) + 1);
    for (const [iface, n] of counts) {
      const ifc = sw.running.interfaces[iface];
      if (!ifc || ifc.daiTrust || sw.errDisabled?.[iface]) continue;
      const limit = ifc.daiRate === undefined ? 15 : ifc.daiRate;
      if (limit === null) continue;
      const pps = Math.round(n * 1.6);
      if (pps > limit) out.push({ device: sw.id, iface, pps });
    }
  }
  return out;
}

// ---- IP source guard, port ACLs, VLAN maps ------------------------------------------------------

function accessPortOf(net: Network, host: Device): { sw: Device; iface: string } | null {
  for (const name of Object.keys(host.hardware)) {
    const p = net.peerOf(host.id, name);
    if (p && isSwitchKind(net.device(p.device).kind)) return { sw: net.device(p.device), iface: p.iface };
  }
  return null;
}

/** L2 filters between two adjacent L3 stations: port ACLs and IP source guard where a host enters, VLAN maps on the way. */
export function l2Permits(net: Network, from: End, to: End, pkt: Packet, count: boolean): boolean {
  const src = net.device(from.device);
  if (isHostKind(src.kind)) {
    const port = accessPortOf(net, src);
    const ifc = port?.sw.running.interfaces[port.iface];
    if (port && ifc?.switchport) {
      if (ifc.verifySource) {
        const vlan = ifc.switchport.accessVlan;
        if (!bound(net, port.sw, macOf(src, from.iface), pkt.src, vlan)) return false;
      }
      const pacl = ifc.accessGroup?.in ? port.sw.running.acls?.[ifc.accessGroup.in] : undefined;
      if (pacl && pacl.entries.some((e) => e.remark === undefined)) {
        const r = evaluate(pacl, pkt);
        if (count && r.seq !== null) {
          const hits = (port.sw.aclHits ??= {});
          hits[`${pacl.name}:${r.seq}`] = (hits[`${pacl.name}:${r.seq}`] ?? 0) + 1;
        }
        if (!r.permit) return false;
      }
    }
  }
  if (!net.devicesWithVlanFilters().length) return true;
  for (const p of switchesBetween(net, from, to)) {
    const filter = p.sw.running.vlanFilters?.find((f) => f.vlans.includes(p.vlan));
    if (filter && !vlanMapForwards(p.sw, filter.map, pkt)) return false;
  }
  return true;
}

/** A VLAN access map: first entry whose match clauses hit decides; no match at all drops (the implicit drop). */
export function vlanMapForwards(sw: Device, name: string, pkt: Packet): boolean {
  const entries = [...(sw.running.vlanMaps?.[name] ?? [])].sort((a, b) => a.seq - b.seq);
  if (!entries.length) return true;
  for (const e of entries) {
    // A MAC match never matches IP traffic; no match clause at all matches everything.
    const clauses = e.matchIp.length + e.matchMac.length;
    const hit =
      clauses === 0 ||
      e.matchIp.some((n) => {
        const acl = sw.running.acls?.[n];
        return !!acl && evaluate(acl, pkt).permit;
      });
    if (hit) return e.action === 'forward';
  }
  return false;
}

// ---- show commands ------------------------------------------------------------------------------

export function showSnooping(sw: Device): string[] {
  const s = sw.running.snooping;
  const on = !!s?.enabled;
  const vlans = s?.vlans.length ? formatVlanList(s.vlans) : '';
  const lines = [
    `Switch DHCP snooping is ${on ? 'enabled' : 'disabled'}`,
    'Switch DHCP gleaning is disabled',
    'DHCP snooping is configured on following VLANs:',
    vlans || 'none',
    'DHCP snooping is operational on following VLANs:',
    on && vlans ? vlans : 'none',
    'DHCP snooping is configured on the following L3 Interfaces:',
    '',
    `Insertion of option 82 is ${s?.option82 === false ? 'disabled' : 'enabled'}`,
    '   circuit-id default format: vlan-mod-port',
    `   remote-id: ${sw.baseMac} (MAC)`,
    'Option 82 on untrusted port is not allowed',
    'Verification of hwaddr field is enabled',
    'Verification of giaddr field is enabled',
    'DHCP snooping trust/rate is configured on the following Interfaces:',
    '',
    'Interface                  Trusted    Allow option    Rate limit (pps)',
    '-----------------------    -------    ------------    ----------------',
  ];
  for (const ifc of Object.values(sw.running.interfaces)) {
    if (!ifc.snoopTrust && ifc.snoopRate === undefined) continue;
    lines.push(`${ifc.name.padEnd(27)}${(ifc.snoopTrust ? 'yes' : 'no').padEnd(11)}${(ifc.snoopTrust ? 'yes' : 'no').padEnd(16)}${ifc.snoopRate ?? 'unlimited'}`);
  }
  return lines;
}

function macColons(mac: string): string {
  return mac.replace(/\./g, '').toUpperCase().replace(/(..)(?=.)/g, '$1:');
}

export function showSnoopBindings(net: Network, sw: Device): string[] {
  const rows = Object.values(sw.snoopBindings ?? {}).filter((b: SnoopBinding) => b.expires > net.time);
  const lines = ['MacAddress          IpAddress        Lease(sec)  Type           VLAN  Interface', '------------------  ---------------  ----------  -------------  ----  --------------------'];
  for (const b of rows) {
    lines.push(`${macColons(b.mac).padEnd(20)}${formatIp(b.ip).padEnd(17)}${String(Math.floor((b.expires - net.time) / 1000)).padEnd(12)}${'dhcp-snooping'.padEnd(15)}${String(b.vlan).padEnd(6)}${b.iface}`);
  }
  lines.push(`Total number of bindings: ${rows.length}`, '');
  return lines;
}

export function showSourceBindings(net: Network, sw: Device): string[] {
  const lines = ['MacAddress          IpAddress        Lease(sec)  Type           VLAN  Interface', '------------------  ---------------  ----------  -------------  ----  --------------------'];
  let n = 0;
  for (const b of sw.running.sourceBindings ?? []) {
    lines.push(`${macColons(b.mac).padEnd(20)}${formatIp(b.ip).padEnd(17)}${'infinite'.padEnd(12)}${'static'.padEnd(15)}${String(b.vlan).padEnd(6)}${b.iface}`);
    n++;
  }
  for (const b of Object.values(sw.snoopBindings ?? {}).filter((x) => x.expires > net.time)) {
    lines.push(`${macColons(b.mac).padEnd(20)}${formatIp(b.ip).padEnd(17)}${String(Math.floor((b.expires - net.time) / 1000)).padEnd(12)}${'dhcp-snooping'.padEnd(15)}${String(b.vlan).padEnd(6)}${b.iface}`);
    n++;
  }
  lines.push(`Total number of bindings: ${n}`, '');
  return lines;
}

export function showArpInspection(sw: Device, only?: number): string[] {
  const d = sw.running.dai;
  const v = (k: string) => (d?.validate.includes(k as never) ? 'Enabled' : 'Disabled');
  const lines = ['', `Source Mac Validation      : ${v('src-mac')}`, `Destination Mac Validation : ${v('dst-mac')}`, `IP Address Validation      : ${v('ip')}`, ''];
  lines.push(' Vlan     Configuration    Operation   ACL Match          Static ACL', ' ----     -------------    ---------   ---------          ----------');
  const vlans = only !== undefined ? [only] : (d?.vlans ?? []);
  for (const vlan of vlans) {
    const enabled = !!d?.vlans.includes(vlan);
    const f = d?.filters.find((x) => x.vlans.includes(vlan));
    const active = enabled && !!sw.vlans[vlan];
    lines.push(`${String(vlan).padStart(5)}     ${(enabled ? 'Enabled' : 'Disabled').padEnd(17)}${(active ? 'Active' : 'Inactive').padEnd(12)}${(f?.acl ?? '').padEnd(19)}${f ? (f.static ? 'Yes' : 'No') : ''}`);
  }
  lines.push('', ` Vlan      ACL Logging      DHCP Logging      Probe Logging`, ' ----      -----------      ------------      -------------');
  for (const vlan of vlans) lines.push(`${String(vlan).padStart(5)}      Deny             Deny              Off`);
  lines.push('', ' Vlan      Forwarded        Dropped     DHCP Drops      ACL Drops', ' ----      ---------        -------     ----------      ---------');
  for (const vlan of vlans) lines.push(`${String(vlan).padStart(5)}      ${String(0).padStart(9)}        ${String(sw.daiDrops ?? 0).padStart(7)}     ${String(sw.daiDrops ?? 0).padStart(10)}      ${String(0).padStart(9)}`);
  return lines;
}

export function showArpInspectionInterfaces(sw: Device, short: (n: string) => string): string[] {
  const lines = ['', ' Interface        Trust State     Rate (pps)    Burst Interval', ' ---------------  -----------     ----------    --------------'];
  for (const ifc of Object.values(sw.running.interfaces)) {
    if (!ifc.switchport || !sw.hardware[ifc.name]) continue;
    const rate = ifc.daiRate === null ? 'None' : String(ifc.daiTrust && ifc.daiRate === undefined ? 'None' : (ifc.daiRate ?? 15));
    lines.push(` ${short(ifc.name).padEnd(17)}${(ifc.daiTrust ? 'Trusted' : 'Untrusted').padEnd(16)}${rate.padStart(10)}    ${String(1).padStart(14)}`);
  }
  return lines;
}

export function showVerifySource(net: Network, sw: Device, short: (n: string) => string): string[] {
  const lines = ['Interface  Filter-type  Filter-mode  IP-address       Mac-address        Vlan', '---------  -----------  -----------  ---------------  -----------------  ----------'];
  for (const ifc of Object.values(sw.running.interfaces)) {
    if (!ifc.verifySource || !ifc.switchport) continue;
    const vlan = ifc.switchport.accessVlan;
    const b = [...Object.values(sw.snoopBindings ?? {}).filter((x) => x.expires > net.time), ...(sw.running.sourceBindings ?? [])].find((x) => x.iface === ifc.name && x.vlan === vlan);
    const mode = snoopOn(sw, vlan) ? 'active' : 'inactive-no-snooping-vlan';
    lines.push(`${short(ifc.name).padEnd(11)}${'ip'.padEnd(13)}${mode.padEnd(13)}${(b ? formatIp(b.ip) : 'deny-all').padEnd(17)}${''.padEnd(19)}${vlan}`);
  }
  return lines;
}
