// `show running-config` lines for dynamic routing: interface-level settings and the `router ...` blocks.

import { formatIp, prefixToMask } from '../ip';
import type { InterfaceConfig } from '../types';
import type { PassiveConfig, Redistribute, RoutingConfig } from './config';

function redistLine(r: Redistribute): string {
  let s = `redistribute ${r.source}${r.id !== undefined ? ` ${r.id}` : ''}`;
  if (r.metric) s += ` metric ${r.metric.join(' ')}`;
  if (r.metricType) s += ` metric-type ${r.metricType}`;
  if (r.subnets) s += ' subnets';
  return s;
}

function passiveLines(p: PassiveConfig, indent: string): string[] {
  if (p.passiveDefault) return [`${indent}passive-interface default`, ...p.exceptions.map((i) => `${indent}no passive-interface ${i}`)];
  return p.exceptions.map((i) => `${indent}passive-interface ${i}`);
}

const area = (a: number) => String(a);

/** Interface lines (after `ip address`). */
export function interfaceRoutingLines(ifc: InterfaceConfig): string[] {
  const out: string[] = [];
  if (ifc.ipMtu) out.push(` ip mtu ${ifc.ipMtu}`);
  const o = ifc.ospf;
  if (o) {
    if (o.auth === 'md5') out.push(' ip ospf authentication message-digest');
    else if (o.auth === 'simple') out.push(' ip ospf authentication');
    else if (o.auth === 'null') out.push(' ip ospf authentication null');
    if (o.authKey) out.push(` ip ospf authentication-key ${o.authKey}`);
    for (const [k, v] of Object.entries(o.mdKeys ?? {})) out.push(` ip ospf message-digest-key ${k} md5 ${v}`);
    if (o.network) out.push(` ip ospf network ${o.network}`);
    if (o.hello !== undefined) out.push(` ip ospf hello-interval ${o.hello}`);
    if (o.dead !== undefined) out.push(` ip ospf dead-interval ${o.dead}`);
    if (o.priority !== undefined) out.push(` ip ospf priority ${o.priority}`);
    if (o.cost !== undefined) out.push(` ip ospf cost ${o.cost}`);
    if (o.mtuIgnore) out.push(' ip ospf mtu-ignore');
    if (o.area) out.push(` ip ospf ${o.area.pid} area ${area(o.area.area)}`);
  }
  if (ifc.delay) out.push(` delay ${ifc.delay}`);
  return out;
}

/** Interface lines that IOS prints before `ip address`. */
export function interfaceTopLines(ifc: InterfaceConfig): string[] {
  const out: string[] = [];
  if (ifc.mtu) out.push(` mtu ${ifc.mtu}`);
  if (ifc.bandwidth) out.push(` bandwidth ${ifc.bandwidth}`);
  return out;
}

export function routerLines(r: RoutingConfig | undefined): string[] {
  if (!r) return [];
  const out: string[] = [];
  for (const p of r.eigrp.filter((x) => !x.name)) {
    out.push(`router eigrp ${p.asn}`);
    if (p.k.join() !== '1,0,1,0,0') out.push(` metric weights 0 ${p.k.join(' ')}`);
    for (const n of p.networks) out.push(n.wildcard === null ? ` network ${formatIp(n.addr)}` : ` network ${formatIp(n.addr)} ${formatIp(n.wildcard)}`);
    for (const x of p.redistribute) out.push(` ${redistLine(x)}`);
    if (p.defaultMetric) out.push(` default-metric ${p.defaultMetric.join(' ')}`);
    out.push(...passiveLines(p.passive, ' '));
    if (p.autoSummary) out.push(' auto-summary');
    if (p.routerId !== null) out.push(` eigrp router-id ${formatIp(p.routerId)}`);
    out.push('!');
  }
  for (const p of r.eigrp.filter((x) => x.name)) {
    out.push(`router eigrp ${p.name}`, ' !', ` address-family ipv4 unicast autonomous-system ${p.asn}`, '  !');
    if (p.passive.passiveDefault) out.push('  af-interface default', '   passive-interface', '  exit-af-interface', '  !');
    for (const i of p.passive.exceptions) out.push(`  af-interface ${i}`, p.passive.passiveDefault ? '   no passive-interface' : '   passive-interface', '  exit-af-interface', '  !');
    out.push('  topology base');
    for (const x of p.redistribute) out.push(`   ${redistLine(x)}`);
    if (p.defaultMetric) out.push(`   default-metric ${p.defaultMetric.join(' ')}`);
    if (p.autoSummary) out.push('   auto-summary');
    out.push('  exit-af-topology');
    for (const n of p.networks) out.push(n.wildcard === null ? `  network ${formatIp(n.addr)}` : `  network ${formatIp(n.addr)} ${formatIp(n.wildcard)}`);
    if (p.routerId !== null) out.push(`  eigrp router-id ${formatIp(p.routerId)}`);
    if (p.k.join() !== '1,0,1,0,0') out.push(`  metric weights 0 ${p.k.join(' ')}`);
    out.push(' exit-address-family', '!');
  }
  for (const p of r.ospf) {
    out.push(`router ospf ${p.pid}`);
    if (p.routerId !== null) out.push(` router-id ${formatIp(p.routerId)}`);
    if (p.refBw !== 100) out.push(` auto-cost reference-bandwidth ${p.refBw}`);
    for (const [a, cfg] of Object.entries(p.areas)) if (cfg.stub) out.push(` area ${a} stub${cfg.noSummary ? ' no-summary' : ''}`);
    for (const x of p.redistribute) out.push(` ${redistLine(x)}`);
    out.push(...passiveLines(p.passive, ' '));
    for (const n of p.networks) out.push(` network ${formatIp(n.addr)} ${formatIp(n.wildcard)} area ${area(n.area)}`);
    const d = p.defaultOriginate;
    if (d) out.push(` default-information originate${d.always ? ' always' : ''}${d.metric !== undefined ? ` metric ${d.metric}` : ''}${d.metricType === 1 ? ' metric-type 1' : ''}`);
    out.push('!');
  }
  if (r.rip) {
    const p = r.rip;
    out.push('router rip');
    if (p.version) out.push(` version ${p.version}`);
    for (const x of p.redistribute) out.push(` ${redistLine(x)}`);
    out.push(...passiveLines(p.passive, ' '));
    for (const n of p.networks) out.push(` network ${formatIp(n)}`);
    if (p.defaultMetric !== null) out.push(` default-metric ${p.defaultMetric}`);
    if (p.defaultOriginate) out.push(' default-information originate');
    if (!p.autoSummary) out.push(' no auto-summary');
    out.push('!');
  }
  if (r.bgp) {
    const b = r.bgp;
    out.push(`router bgp ${b.asn}`);
    if (b.routerId !== null) out.push(` bgp router-id ${formatIp(b.routerId)}`);
    out.push(' bgp log-neighbor-changes');
    for (const n of b.networks) out.push(` network ${formatIp(n.addr)} mask ${formatIp(prefixToMask(n.prefix))}`);
    for (const x of b.redistribute) out.push(` ${redistLine(x)}`);
    for (const [ip, n] of Object.entries(b.neighbors)) {
      out.push(` neighbor ${ip} remote-as ${n.remoteAs}`);
      if (n.description) out.push(` neighbor ${ip} description ${n.description}`);
      if (n.ebgpMultihop) out.push(` neighbor ${ip} ebgp-multihop${n.ebgpMultihop === 255 ? '' : ` ${n.ebgpMultihop}`}`);
      if (n.updateSource) out.push(` neighbor ${ip} update-source ${n.updateSource}`);
      if (n.shutdown) out.push(` neighbor ${ip} shutdown`);
      if (n.nextHopSelf) out.push(` neighbor ${ip} next-hop-self`);
      if (n.defaultOriginate) out.push(` neighbor ${ip} default-originate`);
    }
    out.push('!');
  }
  return out;
}
