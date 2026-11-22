// Show and clear commands for dynamic routing, in IOS formats.

import { ageText } from '../control/common';
import { controlPlane } from '../control';
import { formatIp, inSubnet, parseIp, prefixToMask, type Ipv4 } from '../ip';
import { shortIfName } from '../ifnames';
import { isPassive } from '../control/config';
import { routingTable, type Route } from '../routing';
import { eigrpMetric } from '../control/eigrp';
import { caret, commit, type Ctx, type Tree } from './context';
import { routeLines, showRouteTable } from '../render';

const HS: Record<string, string> = {
  show: 'Show running system information',
  ip: 'IP information',
  protocols: 'IP routing protocol process parameters and statistics',
  ospf: 'OSPF information',
  neighbor: 'Neighbor list',
  detail: 'Detail of all neighbors',
  interface: 'Interface information',
  brief: 'Brief summary of OSPF interface',
  if: 'Interface name',
  database: 'Database summary',
  eigrp: 'IP-EIGRP show commands',
  neighbors: 'IP-EIGRP neighbors',
  topology: 'IP-EIGRP Topology Table',
  interfaces: 'IP-EIGRP interfaces',
  rip: 'IP RIP show commands',
  bgp: 'BGP information',
  summary: 'Summary of BGP neighbor status',
  route: 'IP routing table',
  connected: 'Connected networks',
  static: 'Static routes',
  addr: 'Network to display information about or hostname',
  clear: 'Reset functions',
  process: 'Reset OSPF process',
  '*': 'Clear all',
};

const fmt = formatIp;
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const lpad = (s: string | number, n: number) => String(s).padStart(n);

function deadTime(c: Ctx, dead: number): string {
  const s = dead - (Math.floor(c.net.time / 1000) % Math.max(1, Math.floor(dead / 4))) - 1;
  return `00:00:${String(Math.max(0, s)).padStart(2, '0')}`;
}

function areaText(a: number): string {
  return String(a);
}

// ---------------------------------------------------------------- OSPF

function ospfNeighbors(c: Ctx): string[] {
  const cp = controlPlane(c.net);
  const out = ['', 'Neighbor ID     Pri   State           Dead Time   Address         Interface'];
  for (const inst of cp.ospf.instances.filter((i) => i.dev.id === c.dev.id)) {
    for (const n of inst.neighbors) {
      const role = n.remote.type === 'point-to-point' ? '  -' : n.remote.role === 'DR' ? 'DR' : n.remote.role === 'BDR' ? 'BDR' : 'DROTHER';
      const state = `${n.state}/${role}`;
      out.push(`${pad(fmt(n.remote.inst.rid), 16)}${lpad(n.remote.priority, 3)}   ${pad(state, 16)}${pad(deadTime(c, n.remote.dead), 12)}${pad(fmt(n.remote.iface.address), 16)}${n.local.iface.name}`);
    }
  }
  return out;
}

function ospfInterfaces(c: Ctx, brief: boolean, only?: string): string[] {
  const cp = controlPlane(c.net);
  const out: string[] = brief ? ['Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C'] : [];
  for (const inst of cp.ospf.instances.filter((i) => i.dev.id === c.dev.id)) {
    for (const f of inst.ifaces) {
      if (only && f.iface.name !== only) continue;
      const nbrs = inst.neighbors.filter((n) => n.local === f);
      const fullCount = nbrs.filter((n) => n.state === 'FULL').length;
      const state = f.type === 'loopback' ? 'LOOP' : f.type === 'point-to-point' ? 'P2P' : f.role;
      if (brief) {
        out.push(`${pad(shortIfName(f.iface.name), 13)}${pad(inst.proc.pid, 6)}${pad(areaText(f.area), 16)}${pad(`${fmt(f.iface.address)}/${f.iface.prefix}`, 19)}${pad(f.cost, 6)}${pad(state, 6)}${fullCount}/${nbrs.length}`);
        continue;
      }
      out.push(
        `${f.iface.name} is up, line protocol is up `,
        `  Internet Address ${fmt(f.iface.address)}/${f.iface.prefix}, Area ${areaText(f.area)}, Attached via ${f.viaInterfaceCmd ? 'Interface Enable' : 'Network Statement'}`,
        `  Process ID ${inst.proc.pid}, Router ID ${fmt(inst.rid)}, Network Type ${f.type === 'loopback' ? 'LOOPBACK' : f.type === 'point-to-point' ? 'POINT_TO_POINT' : 'BROADCAST'}, Cost: ${f.cost}`,
        '  Topology-MTID    Cost    Disabled    Shutdown      Topology Name',
        `        0           ${pad(f.cost, 10)}no          no            Base`,
      );
      if (f.type === 'loopback') {
        out.push('  Loopback interface is treated as a stub Host');
        continue;
      }
      out.push(`  Transmit Delay is 1 sec, State ${state}${f.type === 'broadcast' ? `, Priority ${f.priority}` : ''}`);
      if (f.type === 'broadcast') {
        if (f.dr) out.push(`  Designated Router (ID) ${fmt(f.dr.rid)}, Interface address ${fmt(f.dr.addr)}`);
        else out.push('  No designated router on this network');
        if (f.bdr) out.push(`  Backup Designated router (ID) ${fmt(f.bdr.rid)}, Interface address ${fmt(f.bdr.addr)}`);
        else out.push('  No backup designated router on this network');
      }
      out.push(`  Timer intervals configured, Hello ${f.hello}, Dead ${f.dead}, Wait ${f.dead}, Retransmit 5`, '    oob-resync timeout 40');
      out.push(f.passive ? '    No Hellos (Passive interface) ' : `    Hello due in 00:00:0${(Math.floor(c.net.time / 1000) % f.hello) % 10}`);
      out.push('  Supports Link-local Signaling (LLS)', '  Cisco NSF helper support enabled', '  IETF NSF helper support enabled');
      out.push(`  Neighbor Count is ${nbrs.length}, Adjacent neighbor count is ${fullCount} `);
      for (const n of nbrs.filter((x) => x.state === 'FULL')) out.push(`    Adjacent with neighbor ${fmt(n.remote.inst.rid)}${n.remote.role === 'DR' ? '  (Designated Router)' : n.remote.role === 'BDR' ? '  (Backup Designated Router)' : ''}`);
      out.push('  Suppress hello for 0 neighbor(s)');
      if (f.auth !== 'null') out.push(f.auth.startsWith('md5') ? '  Cryptographic authentication enabled' : '  Simple password authentication enabled');
    }
  }
  return out;
}

function ospfSummary(c: Ctx): string[] {
  const cp = controlPlane(c.net);
  const out: string[] = [];
  for (const inst of cp.ospf.instances.filter((i) => i.dev.id === c.dev.id)) {
    out.push(
      ` Routing Process "ospf ${inst.proc.pid}" with ID ${fmt(inst.rid)}`,
      ' Start time: 00:00:01.234, Time elapsed: ' + ageText(c.net.time - c.dev.bootedAt),
      ' Supports only single TOS(TOS0) routes',
      ' Supports opaque LSA',
      ' Supports Link-local Signaling (LLS)',
      ' Supports area transit capability',
      ...(inst.abr ? [' It is an area border router'] : []),
      ...(inst.asbr ? [' It is an autonomous system boundary router', ' Redistributing External Routes from,'] : []),
      ` Router is not originating router-LSAs with maximum metric`,
      ' Initial SPF schedule delay 5000 msecs',
      ' Minimum hold time between two consecutive SPFs 10000 msecs',
      ' Maximum wait time between two consecutive SPFs 10000 msecs',
      ` Reference bandwidth unit is ${inst.proc.refBw} mbps`,
      ` Number of areas in this router is ${inst.areas.size}. ${[...inst.areas].filter((a) => !inst.proc.areas[a]?.stub).length} normal ${[...inst.areas].filter((a) => inst.proc.areas[a]?.stub).length} stub 0 nssa`,
    );
    for (const a of [...inst.areas].sort((x, y) => x - y)) {
      const ifs = inst.ifaces.filter((f) => f.area === a);
      out.push(`    Area ${a === 0 ? 'BACKBONE(0)' : a}`, `        Number of interfaces in this area is ${ifs.length}${ifs.some((f) => f.type === 'loopback') ? ` (${ifs.filter((f) => f.type === 'loopback').length} loopback)` : ''}`);
      if (inst.proc.areas[a]?.stub) out.push(`        It is a stub area${inst.proc.areas[a].noSummary ? ', no summary LSA in this area' : ''}`);
      out.push('        Area has no authentication', '        SPF algorithm last executed 00:01:12.345 ago');
    }
  }
  return out;
}

function ospfDatabase(c: Ctx): string[] {
  const cp = controlPlane(c.net);
  const me = cp.ospf.instances.find((i) => i.dev.id === c.dev.id);
  if (!me) return [];
  // Everything in my OSPF domain (reachable through adjacencies).
  const domain = new Set([me]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const i of [...domain]) for (const n of i.neighbors) if (!domain.has(n.remote.inst)) domain.add(n.remote.inst), (grew = true);
  }
  const age = (x: number) => 100 + ((x >>> 0) % 1500);
  const out = ['', `            OSPF Router with ID (${fmt(me.rid)}) (Process ID ${me.proc.pid})`];
  for (const a of [...me.areas].sort((x, y) => x - y)) {
    out.push('', `\t\tRouter Link States (Area ${a})`, '', 'Link ID         ADV Router      Age         Seq#       Checksum Link count');
    for (const i of [...domain].filter((x) => x.areas.has(a)).sort((x, y) => x.rid - y.rid)) {
      out.push(`${pad(fmt(i.rid), 16)}${pad(fmt(i.rid), 16)}${pad(age(i.rid), 12)}0x80000${String(3 + (i.ifaces.length % 6)).padStart(3, '0')} 0x00${(i.rid & 0xffff).toString(16).toUpperCase().padStart(4, '0')} ${i.ifaces.filter((f) => f.area === a).length}`);
    }
    const nets = [...domain].flatMap((i) => i.ifaces.filter((f) => f.area === a && f.type === 'broadcast' && f.role === 'DR' && i.neighbors.some((n) => n.local === f)));
    if (nets.length) {
      out.push('', `\t\tNet Link States (Area ${a})`, '', 'Link ID         ADV Router      Age         Seq#       Checksum');
      for (const f of nets) out.push(`${pad(fmt(f.iface.address), 16)}${pad(fmt(f.inst.rid), 16)}${pad(age(f.iface.address), 12)}0x80000001 0x00${(f.iface.address & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }
  const ext = [...domain].flatMap((i) => i.externals.map((e) => ({ e, i })));
  if (ext.length) {
    out.push('', '\t\tType-5 AS External Link States', '', 'Link ID         ADV Router      Age         Seq#       Checksum Tag');
    for (const { e, i } of ext) out.push(`${pad(fmt(e.network), 16)}${pad(fmt(i.rid), 16)}${pad(age(e.network + i.rid), 12)}0x80000001 0x00${((e.network ^ i.rid) & 0xffff).toString(16).toUpperCase().padStart(4, '0')} 1`);
  }
  return out;
}

// ---------------------------------------------------------------- EIGRP

function eigrpNeighbors(c: Ctx): string[] {
  const cp = controlPlane(c.net);
  const out: string[] = [];
  for (const inst of cp.eigrp.instances.filter((i) => i.dev.id === c.dev.id)) {
    out.push(`EIGRP-IPv4 ${inst.proc.name ? `VR(${inst.proc.name}) Address-Family ` : ''}Neighbors for AS(${inst.proc.asn})`);
    out.push('H   Address                 Interface              Hold Uptime   SRTT   RTO  Q  Seq', '                                                   (sec)         (ms)       Cnt Num');
    inst.neighbors.forEach((n, i) => {
      out.push(`${pad(i, 4)}${pad(fmt(n.remote.iface.address), 24)}${pad(shortIfName(n.local.iface.name), 23)}${lpad(11 + (Math.floor(c.net.time / 1000) % 4), 4)} ${ageText(c.net.time - c.dev.bootedAt)}    1   100  0  ${3 + i}`);
    });
  }
  return out;
}

function eigrpTopology(c: Ctx): string[] {
  const cp = controlPlane(c.net);
  const out: string[] = [];
  for (const inst of cp.eigrp.instances.filter((i) => i.dev.id === c.dev.id)) {
    out.push(
      `EIGRP-IPv4 ${inst.proc.name ? `VR(${inst.proc.name}) ` : ''}Topology Table for AS(${inst.proc.asn})/ID(${fmt(inst.rid)})`,
      'Codes: P - Passive, A - Active, U - Update, Q - Query, R - Reply,',
      '       r - reply Status, s - sia Status ',
      '',
    );
    for (const e of [...inst.table.values()].sort((a, b) => a.network - b.network)) {
      const fd = eigrpMetric(inst.proc, e.bw, e.delay);
      out.push(`P ${fmt(e.network)}/${e.prefix}, ${Math.max(1, e.hops.length)} successors, FD is ${fd}${e.external && !e.hops.length ? ', tag is 0' : ''}`);
      if (!e.hops.length) out.push(e.external ? '        via Redistributed (' + fd + '/0)' : `        via Connected, ${inst.ifaces.find((f) => inSubnet(f.iface.address, e.network, e.prefix))?.iface.name ?? 'Null0'}`);
      for (const h of e.hops) out.push(`        via ${fmt(h.nextHop)} (${fd}/${h.reported}), ${h.iface}`);
    }
  }
  return out;
}

function eigrpInterfaces(c: Ctx): string[] {
  const cp = controlPlane(c.net);
  const out: string[] = [];
  for (const inst of cp.eigrp.instances.filter((i) => i.dev.id === c.dev.id)) {
    out.push(`EIGRP-IPv4 ${inst.proc.name ? `VR(${inst.proc.name}) Address-Family ` : ''}Interfaces for AS(${inst.proc.asn})`);
    out.push('                              Xmit Queue   PeerQ        Mean   Pacing Time   Multicast    Pending', 'Interface              Peers  Un/Reliable  Un/Reliable  SRTT   Un/Reliable   Flow Timer   Routes');
    for (const f of inst.ifaces.filter((x) => !x.passive)) {
      out.push(`${pad(shortIfName(f.iface.name), 23)}${lpad(inst.neighbors.filter((n) => n.local === f).length, 5)}        0/0       0/0           1       0/0           50           0`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- RIP, BGP

function ripDatabase(c: Ctx): string[] {
  const cp = controlPlane(c.net);
  const inst = cp.rip.instances.find((i) => i.dev.id === c.dev.id);
  if (!inst) return [];
  const out: string[] = [];
  for (const e of [...inst.table.values()].sort((a, b) => a.network - b.network || a.prefix - b.prefix)) {
    out.push(`${fmt(e.network)}/${e.prefix}${e.via.length ? '' : e.hops === 0 && e.network !== 0 ? `    directly connected, ${inst.ifaces.find((f) => inSubnet(f.iface.address, e.network, e.prefix))?.iface.name ?? ''}` : '    redistributed'}`);
    for (const v of e.via) out.push(`    [${e.hops}] via ${fmt(v.nextHop)}, 00:00:${String(Math.floor(c.net.time / 1000) % 30).padStart(2, '0')}, ${v.iface}`);
  }
  return out;
}

function bgpSummary(c: Ctx): string[] {
  const cp = controlPlane(c.net);
  const inst = cp.bgp.instances.find((i) => i.dev.id === c.dev.id);
  if (!inst) return ['% BGP not active'];
  const entries = new Set(inst.paths.map((p) => `${p.network}/${p.prefix}`)).size;
  const out = [
    `BGP router identifier ${fmt(inst.rid)}, local AS number ${inst.cfg.asn}`,
    `BGP table version is ${entries + 1}, main routing table version ${entries + 1}`,
    `${entries} network entries using ${entries * 144} bytes of memory`,
    `${inst.paths.length} path entries using ${inst.paths.length * 80} bytes of memory`,
    '',
    'Neighbor        V           AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd',
  ];
  for (const s of inst.sessions) {
    const up = s.state === 'Established';
    const msgs = up ? 10 + Math.floor((c.net.time - c.dev.bootedAt) / 60000) : 0;
    out.push(`${pad(fmt(s.peer), 16)}4 ${lpad(s.remoteAs, 10)} ${lpad(msgs, 7)} ${lpad(msgs, 7)} ${lpad(up ? entries + 1 : 0, 8)}    0    0 ${pad(up ? ageText(c.net.time - c.dev.bootedAt) : 'never', 8)} ${up ? lpad(s.prefixesReceived, 8) : s.state}`);
  }
  return out;
}

function bgpTable(c: Ctx): string[] {
  const cp = controlPlane(c.net);
  const inst = cp.bgp.instances.find((i) => i.dev.id === c.dev.id);
  if (!inst) return ['% BGP not active'];
  const out = [
    `BGP table version is ${inst.paths.length + 1}, local router ID is ${fmt(inst.rid)}`,
    'Status codes: s suppressed, d damped, h history, * valid, > best, i - internal, ',
    '              r RIB-failure, S Stale, m multipath, b backup-path, f RT-Filter, ',
    '              x best-external, a additional-path, c RIB-compressed, ',
    'Origin codes: i - IGP, e - EGP, ? - incomplete',
    'RPKI validation codes: V valid, I invalid, N Not found',
    '',
    '     Network          Next Hop            Metric LocPrf Weight Path',
  ];
  const sorted = [...inst.paths].sort((a, b) => a.network - b.network || a.prefix - b.prefix || Number(!a.best) - Number(!b.best));
  let last = '';
  for (const p of sorted) {
    const k = `${p.network}/${p.prefix}`;
    const classful = p.prefix === (p.network === 0 ? 0 : p.prefix);
    const net = k === last ? '' : p.prefix === 0 ? '0.0.0.0' : `${fmt(p.network)}${classful ? `/${p.prefix}` : ''}`;
    last = k;
    const status = `${p.inaccessible ? ' ' : '*'}${p.best ? '>' : ' '}${p.ibgp ? 'i' : ' '}`;
    out.push(` ${status} ${pad(net, 17)}${pad(p.nextHop === 0 ? '0.0.0.0' : fmt(p.nextHop), 20)}${lpad(p.nextHop === 0 ? 0 : '', 6)}${lpad(p.ibgp ? 100 : '', 7)}${lpad(p.nextHop === 0 ? 32768 : 0, 7)} ${[...p.asPath, p.origin].join(' ')}`);
  }
  return out;
}

// ---------------------------------------------------------------- show ip protocols, show ip route variants

function showProtocols(c: Ctx): string[] {
  const r = c.dev.running.routing;
  const cp = controlPlane(c.net);
  const out = ['*** IP Routing is NSF aware ***', ''];
  for (const p of r?.eigrp ?? []) {
    const inst = cp.eigrp.instances.find((i) => i.dev.id === c.dev.id && i.proc === p);
    out.push(
      `Routing Protocol is "eigrp ${p.asn}"`,
      '  Outgoing update filter list for all interfaces is not set',
      '  Incoming update filter list for all interfaces is not set',
      '  Default networks flagged in outgoing updates',
      '  Default networks accepted from incoming updates',
      ...(p.redistribute.length ? [`  Redistributing: ${p.redistribute.map((x) => x.source + (x.id ? ` ${x.id}` : '')).join(', ')}`] : []),
      `  EIGRP-IPv4 Protocol for AS(${p.asn})${p.name ? ` VR(${p.name})` : ''}`,
      `    Metric weight K1=${p.k[0]}, K2=${p.k[1]}, K3=${p.k[2]}, K4=${p.k[3]}, K5=${p.k[4]}`,
      `    Router-ID: ${fmt(inst?.rid ?? 0)}`,
      '    Topology : 0 (base) ',
      '      Active Timer: 3 min',
      '      Distance: internal 90 external 170',
      '      Maximum path: 4',
      '      Maximum hopcount 100',
      '      Maximum metric variance 1',
      '',
      `  Automatic Summarization: ${p.autoSummary ? 'enabled' : 'disabled'}`,
      '  Maximum path: 4',
      '  Routing for Networks:',
      ...p.networks.map((n) => `    ${fmt(n.addr)}${n.wildcard === null ? '' : `/${32 - Math.log2(n.wildcard + 1)}`}`),
    );
    const passive = (inst?.ifaces ?? []).filter((f) => f.passive);
    if (passive.length) out.push('  Passive Interface(s):', ...passive.map((f) => `    ${f.iface.name}`));
    out.push('  Routing Information Sources:', '    Gateway         Distance      Last Update');
    for (const n of inst?.neighbors ?? []) out.push(`    ${pad(fmt(n.remote.iface.address), 16)}${lpad(90, 8)}      00:00:${String(Math.floor(c.net.time / 1000) % 60).padStart(2, '0')}`);
    out.push('  Distance: internal 90 external 170', '');
  }
  for (const p of r?.ospf ?? []) {
    const inst = cp.ospf.instances.find((i) => i.dev.id === c.dev.id && i.proc === p);
    out.push(
      `Routing Protocol is "ospf ${p.pid}"`,
      '  Outgoing update filter list for all interfaces is not set',
      '  Incoming update filter list for all interfaces is not set',
      `  Router ID ${fmt(inst?.rid ?? 0)}`,
      ...(inst?.asbr ? ['  It is an autonomous system boundary router', `  Redistributing External Routes from,`, ...p.redistribute.map((x) => `    ${x.source}${x.id ? ` ${x.id}` : ''}${x.subnets ? ', includes subnets in redistribution' : ''}`)] : []),
      `  Number of areas in this router is ${inst?.areas.size ?? 0}. ${[...(inst?.areas ?? [])].filter((a) => !p.areas[a]?.stub).length} normal ${[...(inst?.areas ?? [])].filter((a) => p.areas[a]?.stub).length} stub 0 nssa`,
      '  Maximum path: 4',
      '  Routing for Networks:',
      ...p.networks.map((n) => `    ${fmt(n.addr)} ${fmt(n.wildcard)} area ${n.area}`),
    );
    const viaIf = (inst?.ifaces ?? []).filter((f) => f.viaInterfaceCmd);
    if (viaIf.length) out.push('  Routing on Interfaces Configured Explicitly (Area 0):', ...viaIf.map((f) => `    ${f.iface.name}`));
    const passive = (inst?.ifaces ?? []).filter((f) => isPassive(p.passive, f.iface.name));
    if (passive.length) out.push('  Passive Interface(s):', ...passive.map((f) => `    ${f.iface.name}`));
    out.push('  Routing Information Sources:', '    Gateway         Distance      Last Update');
    for (const n of inst?.neighbors ?? []) if (n.state !== 'EXSTART') out.push(`    ${pad(fmt(n.remote.inst.rid), 16)}${lpad(110, 8)}      ${ageText(c.net.time - c.dev.bootedAt)}`);
    out.push('  Distance: (default is 110)', '');
  }
  if (r?.rip) {
    const p = r.rip;
    const inst = cp.rip.instances.find((i) => i.dev.id === c.dev.id);
    out.push(
      'Routing Protocol is "rip"',
      '  Outgoing update filter list for all interfaces is not set',
      '  Incoming update filter list for all interfaces is not set',
      `  Sending updates every 30 seconds, next due in ${Math.floor(c.net.time / 1000) % 30} seconds`,
      '  Invalid after 180 seconds, hold down 180, flushed after 240',
      ...(p.redistribute.length ? [`  Redistributing: rip, ${p.redistribute.map((x) => x.source + (x.id ? ` ${x.id}` : '')).join(', ')}`] : ['  Redistributing: rip']),
      `  Default version control: send version ${p.version ?? 1}, receive ${p.version === 2 ? 'version 2' : p.version === 1 ? 'version 1' : 'any version'}`,
      '    Interface             Send  Recv  Triggered RIP  Key-chain',
    );
    for (const f of (inst?.ifaces ?? []).filter((x) => !x.passive)) out.push(`    ${pad(f.iface.name, 22)}${pad(p.version ?? 1, 6)}${pad(p.version === 2 ? '2' : p.version === 1 ? '1' : '1 2', 6)}`);
    out.push(`  Automatic network summarization is ${p.autoSummary ? 'in effect' : 'not in effect'}`, '  Maximum path: 4', '  Routing for Networks:', ...p.networks.map((n) => `    ${fmt(n)}`));
    const passive = (inst?.ifaces ?? []).filter((f) => f.passive);
    if (passive.length) out.push('  Passive Interface(s):', ...passive.map((f) => `    ${f.iface.name}`));
    out.push('  Routing Information Sources:', '    Gateway         Distance      Last Update');
    for (const s of inst?.sources ?? []) out.push(`    ${pad(fmt(s.remote.iface.address), 16)}${lpad(120, 8)}      00:00:${String(Math.floor(c.net.time / 1000) % 30).padStart(2, '0')}`);
    out.push('  Distance: (default is 120)', '');
  }
  if (r?.bgp) {
    out.push(
      `Routing Protocol is "bgp ${r.bgp.asn}"`,
      '  Outgoing update filter list for all interfaces is not set',
      '  Incoming update filter list for all interfaces is not set',
      '  IGP synchronization is disabled',
      '  Automatic route summarization is disabled',
      ...(r.bgp.networks.length ? ['  Routing for Networks:', ...r.bgp.networks.map((n) => `    ${fmt(n.addr)}/${n.prefix}`)] : []),
      '  Neighbor(s):',
      '    Address          FiltIn FiltOut DistIn DistOut Weight RouteMap',
      ...Object.keys(r.bgp.neighbors).map((n) => `    ${pad(n, 17)}`),
      '  Maximum path: 1',
      '  Routing Information Sources:',
      '    Gateway         Distance      Last Update',
      '  Distance: external 20 internal 200 local 200',
      '',
    );
  }
  return out;
}

const CODE_FOR: Record<string, (r: Route) => boolean> = {
  ospf: (r) => r.code === 'O',
  eigrp: (r) => r.code === 'D',
  rip: (r) => r.code === 'R',
  bgp: (r) => r.code === 'B',
  static: (r) => r.code === 'S',
  connected: (r) => r.code === 'C' || r.code === 'L',
};

function routeDetail(c: Ctx, addr: Ipv4): string[] {
  const table = routingTable(c.net, c.dev);
  const matches = table.filter((r) => inSubnet(addr, r.network, r.prefix) && !(r.code === 'L' && r.network !== addr));
  if (!matches.length) return ['% Network not in table'];
  const best = Math.max(...matches.map((r) => r.prefix));
  const set = matches.filter((r) => r.prefix === best);
  const r = set[0];
  const known = r.code === 'C' || r.code === 'L' ? 'connected' : r.code === 'S' ? 'static' : r.source;
  const type = r.code === 'O' ? (r.sub === 'IA' ? ', type inter area' : r.sub === 'E2' ? ', type extern 2, forward metric 1' : r.sub === 'E1' ? ', type extern 1' : ', type intra area') : r.code === 'D' ? (r.sub === 'EX' ? ', type external' : ', type internal') : '';
  const out = [`Routing entry for ${fmt(r.network)}/${r.prefix}${r.prefix === 0 ? ', supernet' : ''}`, `  Known via "${known}", distance ${r.distance}, metric ${r.metric}${type}`];
  if (r.isDefault) out.push('  Gateway of last resort');
  if (r.since !== undefined && r.nextHop !== null) out.push(`  Last update from ${fmt(r.nextHop)}${r.iface ? ` on ${r.iface}` : ''}, ${ageText(c.net.time - r.since)} ago`);
  out.push('  Routing Descriptor Blocks:');
  set.forEach((x, i) => {
    if (x.code === 'C' || x.code === 'L') out.push(`  * directly connected, via ${x.iface}`);
    else out.push(`  ${i === 0 ? '*' : ' '} ${x.nextHop !== null ? fmt(x.nextHop) : 'directly connected'}${x.originator !== undefined ? `, from ${fmt(x.originator)}` : ''}${x.since !== undefined ? `, ${ageText(c.net.time - x.since)} ago` : ''}${x.iface ? `, via ${x.iface}` : ''}`);
    out.push(`      Route metric is ${x.metric}, traffic share count is 1`);
  });
  return out;
}

export function addRoutingShows(t: Tree, privileged: boolean): void {
  t.add('show ip protocols', HS, (c) => c.out.push(...showProtocols(c)));
  t.add('show ip ospf', HS, (c) => c.out.push(...ospfSummary(c)));
  t.add('show ip ospf neighbor', HS, (c) => c.out.push(...ospfNeighbors(c)));
  t.add('show ip ospf interface', HS, (c) => c.out.push(...ospfInterfaces(c, false)));
  t.add('show ip ospf interface brief', HS, (c) => c.out.push(...ospfInterfaces(c, true)));
  t.add('show ip ospf interface <iface:if>', HS, (c, a) => c.out.push(...ospfInterfaces(c, false, a.if as string)));
  t.add('show ip ospf database', HS, (c) => c.out.push(...ospfDatabase(c)));
  t.add('show ip eigrp neighbors', HS, (c) => c.out.push(...eigrpNeighbors(c)));
  t.add('show ip eigrp topology', HS, (c) => c.out.push(...eigrpTopology(c)));
  t.add('show ip eigrp interfaces', HS, (c) => c.out.push(...eigrpInterfaces(c)));
  t.add('show ip rip database', HS, (c) => c.out.push(...ripDatabase(c)));
  t.add('show ip bgp', HS, (c) => c.out.push(...bgpTable(c)));
  t.add('show ip bgp summary', HS, (c) => c.out.push(...bgpSummary(c)));
  for (const kind of Object.keys(CODE_FOR)) {
    t.add(`show ip route ${kind}`, HS, (c) => {
      const all = routingTable(c.net, c.dev);
      c.out.push(...showRouteTable(c.net, all.filter(CODE_FOR[kind]), true, all));
    });
  }
  t.add('show ip route <ip:addr>', HS, (c, a) => c.out.push(...routeDetail(c, parseIp(a.addr as string)!)));
  if (privileged) {
    t.add('clear ip ospf process', HS, (c) =>
      c.s.ask({
        prompt: 'Reset ALL OSPF processes? [no]: ',
        handle: (answer) => {
          if (!/^y/i.test(answer.trim())) return;
          commit(c);
        },
      }),
    );
    t.add('clear ip bgp *', HS, (c) => commit(c));
    t.add('clear ip route *', HS, (c) => commit(c));
  }
  void routeLines;
  void prefixToMask;
  void caret;
}
