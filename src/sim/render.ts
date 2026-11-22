// Text output for IOS show commands. Formats follow real IOS output closely, so what players learn transfers.

import { aclConfigLines } from './acl';
import { natConfigLines } from './nat';
import { switchGlobalLines, switchInterfaceLines } from './cli/switchCommands';
import { dhcpConfigLines } from './iosDhcp';
import { ageText, bandwidthKbps, delayTens } from './control/common';
import { interfaceRoutingLines, interfaceTopLines, routerLines } from './control/render';
import { deviceClock, loggingBottomLines, loggingTopLines, ntpLines, timestampLines } from './mgmt';
import { cdpIfName, compareIfNames, shortIfName } from './ifnames';
import { classfulPrefix, formatIp, prefixToMask } from './ip';
import type { Network } from './network';
import { l3Interfaces, macOf, routes, routingTable, type Route } from './routing';
import { interfaceRates } from './traffic';
import { type7Encode } from './hardening';
import { osVersion, runningImageName } from './images';
import { securityGlobalLines, securityInterfaceLines } from './cli/securityCommands';
import type { Device, DeviceConfig, InterfaceConfig, LineConfig } from './types';
import { isHostKind, isSwitchKind } from './types';


function sortedInterfaces(config: DeviceConfig): InterfaceConfig[] {
  return Object.values(config.interfaces).sort((a, b) => compareIfNames(a.name, b.name));
}

/** Formats a VLAN list as IOS does: 1,10,20-30 */
export function formatVlanList(vlans: number[]): string {
  const sorted = [...new Set(vlans)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return parts.join(',');
}

export function parseVlanList(text: string): number[] | null {
  const result: number[] = [];
  for (const part of text.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (from < 1 || to > 4094 || from > to) return null;
    for (let v = from; v <= to; v++) result.push(v);
  }
  return result;
}

/** Type 5 hashes seen in rendered configs, so a saved config can be loaded back (`copy tftp: running-config`). */
const SECRET_REGISTRY = new Map<string, string>();
/** A secret loaded from a hash we can't reverse: it never matches a typed password. */
export const UNKNOWN_SECRET = '\u0000hash:';

export function secretFromHash(hash: string): string {
  return SECRET_REGISTRY.get(hash) ?? UNKNOWN_SECRET + hash;
}

/** Deterministic fake MD5-crypt hash so `enable secret` shows as "$1$..." like the real thing. */
export function fakeSecretHash(secret: string): string {
  if (secret.startsWith(UNKNOWN_SECRET)) return secret.slice(UNKNOWN_SECRET.length);
  const h5 = md5ish(secret);
  SECRET_REGISTRY.set(h5, secret);
  return h5;
}

function md5ish(secret: string): string {
  const alphabet = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let h = 2166136261;
  for (let i = 0; i < secret.length; i++) h = Math.imul(h ^ secret.charCodeAt(i), 16777619);
  let out = '';
  for (let i = 0; i < 26; i++) {
    // xorshift32 spreads the seed so the output doesn't repeat patterns.
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    out += alphabet[(h >>> 0) % 64];
  }
  return `$1$${out.slice(0, 4)}$${out.slice(4)}`;
}

export function renderConfig(device: Device, config: DeviceConfig): string[] {
  const lines: string[] = ['!'];
  lines.push(`version ${osVersion(device).split('(')[0]}`);
  lines.push(...timestampLines(device));
  lines.push(config.servicePasswordEncryption ? 'service password-encryption' : 'no service password-encryption', '!', `hostname ${config.hostname}`, '!');
  if (config.bootSystem?.length) lines.push('boot-start-marker', ...config.bootSystem.map((b) => `boot system ${b}`), 'boot-end-marker', '!');
  if (isSwitchKind(device.kind)) lines.push(...switchGlobalLines(device));
  const top = loggingTopLines(device);
  if (top.length) lines.push(...top, '!');
  if (config.enableSecret) lines.push(`enable secret 5 ${fakeSecretHash(config.enableSecret)}`);
  if (config.enablePassword) lines.push(config.enablePassword.encrypted ? `enable password 7 ${type7Encode(config.enablePassword.pw)}` : `enable password ${config.enablePassword.pw}`);
  if (config.enableSecret || config.enablePassword) lines.push('!');
  if (config.minPasswordLength) lines.push(`security passwords min-length ${config.minPasswordLength}`, '!');
  const userNames = Object.keys(config.users).sort();
  for (const name of userNames) {
    const u = config.users[name];
    const priv = u.privilege !== 1 ? ` privilege ${u.privilege}` : '';
    lines.push(
      u.secret !== null
        ? `username ${name}${priv} secret 5 ${fakeSecretHash(u.secret)}`
        : u.passwordEncrypted
          ? `username ${name}${priv} password 7 ${type7Encode(u.password ?? '')}`
          : `username ${name}${priv} password 0 ${u.password}`,
    );
  }
  if (userNames.length) lines.push('!');
  if (config.archive) {
    const a = config.archive;
    lines.push('archive');
    if (a.path) lines.push(` path ${a.path}`);
    if (a.maximum) lines.push(` maximum ${a.maximum}`);
    if (a.writeMemory) lines.push(' write-memory');
    if (a.timePeriod) lines.push(` time-period ${a.timePeriod}`);
    lines.push('!');
  }
  if (config.loginBlock) {
    lines.push(`login block-for ${config.loginBlock.blockFor} attempts ${config.loginBlock.attempts} within ${config.loginBlock.within}`);
    if (config.loginBlock.quietAcl) lines.push(`login quiet-mode access-class ${config.loginBlock.quietAcl}`);
    lines.push('!');
  }
  if (!config.domainLookup) lines.push('no ip domain-lookup');
  if (config.domainName) lines.push(`ip domain-name ${config.domainName}`);
  for (const ns of config.nameServers?.length ? [config.nameServers] : []) lines.push(`ip name-server ${ns.map(formatIp).join(' ')}`);
  for (const [h, a] of Object.entries(config.hosts ?? {})) lines.push(`ip host ${h} ${formatIp(a)}`);
  if (!config.domainLookup || config.domainName || config.nameServers?.length || Object.keys(config.hosts ?? {}).length) lines.push('!');
  lines.push(...dhcpConfigLines(device));
  if (config.ssh.version) lines.push(`ip ssh version ${config.ssh.version}`);
  if (config.ssh.rotary !== null) lines.push(`ip ssh port ${config.ssh.port} rotary ${config.ssh.rotary}`);
  if (config.authorizedKeys.length) {
    lines.push('ip ssh pubkey-chain');
    for (const user of [...new Set(config.authorizedKeys.map((k) => k.user))]) {
      lines.push(`  username ${user}`);
      for (const k of config.authorizedKeys.filter((x) => x.user === user)) lines.push(`   key-hash ssh-rsa ${keyHash(k.key)} ${k.key}`);
    }
  }
  if (config.ssh.version || config.ssh.rotary !== null || config.authorizedKeys.length) lines.push('!');
  if (device.kind === 'l3switch' && config.ipRouting) lines.push('ip routing', '!');

  for (const ifc of sortedInterfaces(config)) {
    lines.push(`interface ${ifc.name}`);
    if (ifc.description) lines.push(` description ${ifc.description}`);
    if (ifc.encapsulation) {
      const e = ifc.encapsulation;
      lines.push(e.type === 'isl' ? ` encapsulation isl ${e.vlan}` : ` encapsulation dot1Q ${e.vlan}${e.native ? ' native' : ''}`);
    }
    const sp = ifc.switchport;
    if (sp) {
      if (device.kind === 'l3switch' && sp.trunkEncapsulation !== 'auto') lines.push(` switchport trunk encapsulation ${sp.trunkEncapsulation}`);
      if (sp.accessVlan !== 1) lines.push(` switchport access vlan ${sp.accessVlan}`);
      if (sp.nativeVlan !== 1) lines.push(` switchport trunk native vlan ${sp.nativeVlan}`);
      if (sp.allowedVlans !== 'all') {
        lines.push(` switchport trunk allowed vlan ${sp.allowedVlans.length ? formatVlanList(sp.allowedVlans) : 'none'}`);
      }
      if (sp.mode !== 'dynamic auto') lines.push(` switchport mode ${sp.mode}`);
      lines.push(...switchInterfaceLines(ifc));
      lines.push(...securityInterfaceLines(ifc));
    } else if (device.kind === 'l3switch' && !ifc.name.startsWith('Vlan') && !ifc.name.startsWith('Loopback')) {
      lines.push(' no switchport');
    }
    lines.push(...interfaceTopLines(ifc));
    if (!sp) {
      lines.push(ifc.ip ? ` ip address ${formatIp(ifc.ip.address)} ${formatIp(prefixToMask(ifc.ip.prefix))}` : ' no ip address');
      if (ifc.accessGroup?.in) lines.push(` ip access-group ${ifc.accessGroup.in} in`);
      if (ifc.accessGroup?.out) lines.push(` ip access-group ${ifc.accessGroup.out} out`);
      for (const h of ifc.helpers ?? []) lines.push(` ip helper-address ${formatIp(h)}`);
      if (ifc.nat) lines.push(` ip nat ${ifc.nat}`, ' ip virtual-reassembly in');
      if (ifc.relayInfoTrusted) lines.push(' ip dhcp relay information trusted');
      lines.push(...interfaceRoutingLines(ifc));
    }
    const physical = device.hardware[ifc.name] !== undefined;
    if (physical) {
      if (ifc.duplex !== 'auto' || device.kind === 'router') lines.push(` duplex ${ifc.duplex}`);
      if (ifc.speed !== 'auto' || device.kind === 'router') lines.push(` speed ${ifc.speed}`);
    }
    if (ifc.shutdown) lines.push(' shutdown');
    lines.push('!');
  }
  lines.push(...routerLines(config.routing));
  const natLines = natConfigLines(config.nat);
  if (natLines.length) lines.push(...natLines);
  if (config.defaultGateway !== null && !routes(device)) lines.push(`ip default-gateway ${formatIp(config.defaultGateway)}`);
  for (const r of config.staticRoutes) {
    const target = r.exitIf ?? formatIp(r.nextHop!);
    lines.push(
      `ip route ${formatIp(r.network)} ${formatIp(prefixToMask(r.prefix))} ${target}${r.distance !== 1 ? ' ' + r.distance : ''}`,
    );
  }
  if (config.staticRoutes.length || config.defaultGateway !== null) lines.push('!');
  lines.push(...securityGlobalLines(config));
  const aclLines = aclConfigLines(config.acls ?? {});
  if (aclLines.length) lines.push(...aclLines, '!');
  lines.push(...loggingBottomLines(device));
  if (config.bannerExec) lines.push(`banner exec ^C${config.bannerExec}^C`);
  if (config.bannerLogin) lines.push(`banner login ^C${config.bannerLogin}^C`);
  if (config.bannerMotd !== null) lines.push(`banner motd ^C${config.bannerMotd}^C`);
  if (config.bannerExec || config.bannerLogin || config.bannerMotd !== null) lines.push('!');
  lines.push('line con 0', ...renderLine(config.lines.con, false));
  const vty = renderLine(config.lines.vty, true);
  lines.push('!', 'line vty 0 4', ...vty, 'line vty 5 15', ...vty, '!');
  const ntp = ntpLines(device);
  if (ntp.length) lines.push(...ntp, '!');
  lines.push('end');
  return lines;
}

function renderLine(line: LineConfig, isVty: boolean): string[] {
  const out: string[] = [];
  if (line.accessClass) out.push(` access-class ${line.accessClass} in`);
  if (line.execTimeout && (line.execTimeout[0] !== 10 || line.execTimeout[1] !== 0)) out.push(` exec-timeout ${line.execTimeout[0]} ${line.execTimeout[1]}`);
  if (line.password) out.push(line.passwordEncrypted ? ` password 7 ${type7Encode(line.password)}` : ` password ${line.password}`);
  if (line.loggingSynchronous) out.push(' logging synchronous');
  if (line.login === 'local') out.push(' login local');
  else if (line.login === 'line') out.push(' login');
  else if (isVty) out.push(' no login');
  if (line.rotary !== null) out.push(` rotary ${line.rotary}`);
  if (isVty) {
    const { ssh, telnet } = line.transport;
    if (ssh && !telnet) out.push(' transport input ssh');
    else if (telnet && !ssh) out.push(' transport input telnet');
    else if (!ssh && !telnet) out.push(' transport input none');
  }
  return out;
}

/** The hex fingerprint IOS shows for a trusted client key. */
export function keyHash(key: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1b873593;
  for (let i = 0; i < key.length; i++) {
    h1 = Math.imul(h1 ^ key.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 ^ key.charCodeAt(i), 2246822507);
  }
  const hex = (n: number) => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
  return hex(h1) + hex(h2) + hex(h1 ^ h2) + hex(Math.imul(h1, h2));
}

export function showIpSsh(device: Device): string[] {
  const cfg = device.running;
  const versionText = cfg.ssh.version === null ? '1.99' : `${cfg.ssh.version}.0`;
  const enabled = cfg.crypto !== null && !(cfg.ssh.version === 2 && cfg.crypto.bits < 768);
  const lines = [`SSH ${enabled ? 'Enabled' : 'Disabled'} - version ${versionText}`];
  if (!enabled) lines.push('%Please create RSA keys to enable SSH (and of atleast 768 bits for SSH v2).');
  lines.push('Authentication methods:publickey,keyboard-interactive,password', 'Authentication timeout: 120 secs; Authentication retries: 3');
  if (cfg.ssh.rotary !== null) lines.push(`SSH port: 22, ${cfg.ssh.port} (rotary ${cfg.ssh.rotary})`);
  if (cfg.crypto) lines.push(`Modulus Size : ${cfg.crypto.bits} bits`);
  return lines;
}

export function showRunning(device: Device): string[] {
  const body = renderConfig(device, device.running);
  const bytes = body.join('\n').length;
  return ['Building configuration...', '', `Current configuration : ${bytes} bytes`, ...body];
}

export function showStartup(device: Device): string[] {
  if (!device.startup) return ['startup-config is not present'];
  const body = renderConfig(device, device.startup);
  return [`Using ${body.join('\n').length} out of 262144 bytes`, ...body];
}

// ---- interfaces --------------------------------------------------------------

function statusWords(net: Network, device: Device, ifc: InterfaceConfig): { status: string; protocol: string } {
  const s = net.state(device.id, ifc.name);
  return { status: s.link === 'admin-down' ? 'administratively down' : s.link, protocol: s.protocol };
}

export function showIpInterfaceBrief(net: Network, device: Device): string[] {
  const lines = ['Interface              IP-Address      OK? Method Status                Protocol'];
  for (const ifc of sortedInterfaces(device.running)) {
    const { status, protocol } = statusWords(net, device, ifc);
    const ip = ifc.ip && !ifc.switchport ? formatIp(ifc.ip.address) : 'unassigned';
    const method = ifc.ip && !ifc.switchport ? 'manual' : 'unset ';
    lines.push(`${ifc.name.padEnd(23)}${ip.padEnd(16)}YES ${method.padEnd(7)}${status.padEnd(22)}${protocol}`);
  }
  return lines;
}

export function showInterface(net: Network, device: Device, ifc: InterfaceConfig): string[] {
  const { status, protocol } = statusWords(net, device, ifc);
  const hw = device.hardware[ifc.name.split('.')[0]];
  const isGig = ifc.name.startsWith('Gigabit');
  const kind = ifc.name.startsWith('Vlan')
    ? 'EtherSVI'
    : ifc.name.startsWith('Loopback')
      ? 'Loopback'
      : isGig
        ? 'NetSmart Gigabit Ethernet'
        : 'Fast Ethernet';
  const mac = macOf(device, ifc.name);
  const st = net.state(device.id, ifc.name);
  const lines = [`${ifc.name} is ${status}, line protocol is ${protocol}${st.err ? ' (err-disabled)' : st.suspended ? ' (suspended)' : ''}`];
  lines.push(ifc.name.startsWith('Loopback') ? `  Hardware is ${kind}` : `  Hardware is ${kind}, address is ${mac} (bia ${mac})`);
  if (ifc.description) lines.push(`  Description: ${ifc.description}`);
  if (ifc.ip && !ifc.switchport) lines.push(`  Internet address is ${formatIp(ifc.ip.address)}/${ifc.ip.prefix}`);
  const bw = bandwidthKbps(device, ifc.name, net);
  lines.push(`  MTU ${ifc.mtu ?? 1500} bytes, BW ${bw} Kbit/sec, DLY ${delayTens(device, ifc.name) * 10} usec,`, '     reliability 255/255, txload 1/255, rxload 1/255');
  if (ifc.encapsulation?.type === 'isl') lines.push(`  Encapsulation ISL Virtual LAN, Color ${ifc.encapsulation.vlan}.`);
  else if (ifc.encapsulation) lines.push(`  Encapsulation 802.1Q Virtual LAN, Vlan ID  ${ifc.encapsulation.vlan}.`);
  else lines.push('  Encapsulation ARPA, loopback not set');
  if (hw) {
    const up = net.isUp(device.id, ifc.name);
    const speed = net.negotiatedSpeed(device.id, ifc.name) ?? (ifc.speed === 'auto' ? hw.maxSpeed : ifc.speed);
    const duplex = net.negotiatedDuplex(device.id, ifc.name) === 'half' ? 'Half' : 'Full';
    lines.push(up ? `  ${duplex}-duplex, ${speed}Mb/s, media type is RJ45` : '  Auto-duplex, Auto-speed, media type is RJ45');
  }
  lines.push(
    '  Last input never, output never, output hang never',
    '  Input queue: 0/75/0/0 (size/max/drops/flushes); Total output drops: 0',
  );
  const rates = hw ? interfaceRates(net, device.id, ifc.name) : { inBps: 0, outBps: 0 };
  const pps = (bps: number) => Math.round(bps / 8 / 700);
  const uptimeSec = Math.max(0, (net.time - device.bootedAt) / 1000);
  const cnt = device.ifCounters?.[ifc.name];
  const since = Math.max(0, (net.time - Math.max(device.bootedAt, cnt?.since ?? 0)) / 1000);
  const inPkts = Math.round(pps(rates.inBps) * (cnt ? since : uptimeSec));
  const outPkts = Math.round(pps(rates.outBps) * (cnt ? since : uptimeSec));
  const crc = cnt?.crc ?? 0;
  const runts = cnt?.runts ?? 0;
  const late = cnt?.lateCollisions ?? 0;
  const coll = cnt?.collisions ?? 0;
  lines.push(
    `  5 minute input rate ${Math.round(rates.inBps)} bits/sec, ${pps(rates.inBps)} packets/sec`,
    `  5 minute output rate ${Math.round(rates.outBps)} bits/sec, ${pps(rates.outBps)} packets/sec`,
    `     ${inPkts} packets input, ${inPkts * 700} bytes, 0 no buffer`,
    `     Received ${Math.round(inPkts / 40)} broadcasts (${Math.round(inPkts / 90)} multicasts)`,
    `     ${runts} runts, 0 giants, 0 throttles`,
    `     ${crc + runts} input errors, ${crc} CRC, ${Math.round(crc / 7)} frame, 0 overrun, 0 ignored`,
    `     ${outPkts} packets output, ${outPkts * 700} bytes, 0 underruns`,
    `     ${late} output errors, ${coll} collisions, ${cnt ? 1 : 0} interface resets`,
    `     0 babbles, ${late} late collision, ${cnt?.deferred ?? 0} deferred`,
  );
  return lines;
}

/** `show interfaces counters errors` (switches). */
export function showCountersErrors(device: Device): string[] {
  const ports = sortedInterfaces(device.running).filter((i) => device.hardware[i.name] || i.name.startsWith('Port-channel'));
  const c = (n: string) => device.ifCounters?.[n];
  const pad = (v: number, w: number) => String(v).padStart(w);
  const lines = ['', 'Port        Align-Err     FCS-Err    Xmit-Err     Rcv-Err  UnderSize  OutDiscards'];
  for (const p of ports) {
    const x = c(p.name);
    lines.push(`${shortIfName(p.name).padEnd(10)}${pad(Math.round((x?.crc ?? 0) / 7), 11)}${pad(x?.crc ?? 0, 12)}${pad(x?.lateCollisions ?? 0, 12)}${pad((x?.crc ?? 0) + (x?.runts ?? 0), 12)}${pad(x?.runts ?? 0, 11)}${pad(0, 13)}`);
  }
  lines.push('', 'Port      Single-Col  Multi-Col   Late-Col  Excess-Col  Carri-Sen      Runts     Giants');
  for (const p of ports) {
    const x = c(p.name);
    const coll = x?.collisions ?? 0;
    lines.push(`${shortIfName(p.name).padEnd(10)}${pad(Math.ceil(coll * 0.6), 10)}${pad(Math.floor(coll * 0.4), 11)}${pad(x?.lateCollisions ?? 0, 11)}${pad(0, 12)}${pad(0, 11)}${pad(x?.runts ?? 0, 11)}${pad(0, 11)}`);
  }
  lines.push('');
  return lines;
}

export function showInterfacesStatus(net: Network, device: Device): string[] {
  const lines = ['Port      Name               Status       Vlan       Duplex  Speed Type'];
  for (const ifc of sortedInterfaces(device.running)) {
    if (!ifc.switchport && !device.hardware[ifc.name]) continue;
    if (!device.hardware[ifc.name]) continue;
    const s = net.state(device.id, ifc.name);
    const status = s.link === 'admin-down' ? 'disabled' : s.err ? 'err-disabled' : s.suspended ? 'suspended' : s.protocol === 'up' ? 'connected' : 'notconnect';
    let vlan = 'routed';
    if (ifc.switchport) vlan = net.operationalMode(device, ifc) === 'trunk' && s.protocol === 'up' ? 'trunk' : String(ifc.switchport.accessVlan);
    const hw = device.hardware[ifc.name];
    const connected = status === 'connected';
    const duplex = ifc.duplex === 'auto' ? (connected ? `a-${net.negotiatedDuplex(device.id, ifc.name) ?? 'full'}` : 'auto') : ifc.duplex;
    const speed = ifc.speed === 'auto' ? (connected ? `a-${net.negotiatedSpeed(device.id, ifc.name) ?? hw.maxSpeed}` : 'auto') : String(ifc.speed);
    const type = hw.maxSpeed === 1000 ? '10/100/1000BaseTX' : '10/100BaseTX';
    const name = (ifc.description ?? '').slice(0, 18);
    lines.push(
      `${shortIfName(ifc.name).padEnd(10)}${name.padEnd(19)}${status.padEnd(13)}${vlan.padEnd(11)}${duplex.padStart(6)} ${speed.padStart(6)} ${type}`,
    );
  }
  return lines;
}

export function showInterfacesTrunk(net: Network, device: Device): string[] {
  const trunks = sortedInterfaces(device.running).filter(
    (ifc) => ifc.switchport && net.isUp(device.id, ifc.name) && net.operationalMode(device, ifc) === 'trunk',
  );
  if (!trunks.length) return [];
  const modeWord = (ifc: InterfaceConfig) =>
    ifc.switchport!.mode === 'trunk' ? 'on' : ifc.switchport!.mode === 'dynamic desirable' ? 'desirable' : 'auto';
  const lines = ['', 'Port        Mode             Encapsulation  Status        Native vlan'];
  for (const t of trunks) {
    const isl = device.kind === 'l3switch' && t.switchport!.trunkEncapsulation === 'isl';
    const encap = isl ? 'isl' : t.switchport!.mode === 'trunk' ? '802.1q' : 'n-802.1q';
    lines.push(`${shortIfName(t.name).padEnd(12)}${modeWord(t).padEnd(17)}${encap.padEnd(15)}${'trunking'.padEnd(14)}${t.switchport!.nativeVlan}`);
  }
  lines.push('', 'Port        Vlans allowed on trunk');
  for (const t of trunks) {
    const allowed = t.switchport!.allowedVlans;
    lines.push(`${shortIfName(t.name).padEnd(12)}${allowed === 'all' ? '1-4094' : allowed.length ? formatVlanList(allowed) : 'none'}`);
  }
  lines.push('', 'Port        Vlans allowed and active in management domain');
  for (const t of trunks) lines.push(`${shortIfName(t.name).padEnd(12)}${formatVlanList(net.vlansCarried(device, t)) || 'none'}`);
  lines.push('', 'Port        Vlans in spanning tree forwarding state and not pruned');
  for (const t of trunks) lines.push(`${shortIfName(t.name).padEnd(12)}${formatVlanList(net.vlansCarried(device, t)) || 'none'}`);
  return lines;
}

export function showVlanBrief(net: Network, device: Device): string[] {
  const lines = [
    '',
    'VLAN Name                             Status    Ports',
    '---- -------------------------------- --------- -------------------------------',
  ];
  const ids = Object.keys(device.vlans)
    .map(Number)
    .sort((a, b) => a - b);
  for (const id of ids) {
    const ports = sortedInterfaces(device.running)
      .filter((ifc) => {
        if (!ifc.switchport || ifc.switchport.accessVlan !== id) return false;
        // Operational trunks are not listed under a VLAN.
        return !(net.isUp(device.id, ifc.name) && net.operationalMode(device, ifc) === 'trunk');
      })
      .map((ifc) => shortIfName(ifc.name));
    const status = id >= 1002 ? 'act/unsup' : 'active';
    const head = `${String(id).padEnd(5)}${device.vlans[id].name.padEnd(33)}${status.padEnd(10)}`;
    if (!ports.length) {
      lines.push(head.trimEnd());
      continue;
    }
    for (let i = 0; i < ports.length; i += 4) {
      const chunk = ports.slice(i, i + 4).join(', ') + (i + 4 < ports.length ? ',' : '');
      lines.push((i === 0 ? head : ' '.repeat(48)) + chunk);
    }
  }
  return lines;
}

// ---- routing -----------------------------------------------------------------

function codeText(r: Route): string {
  const star = r.isDefault ? '*' : '';
  if (!r.sub) return r.code + star;
  return star ? `${r.code}*${r.sub}` : `${r.code} ${r.sub}`;
}

/** One route (and its equal-cost siblings) as IOS prints them. */
export function routeLines(net: Network, group: Route[], indent: boolean, showMask = true): string[] {
  const r = group[0];
  const code = codeText(r).padEnd(indent ? 9 : 6);
  // Inside an "is subnetted" block (one mask for all), IOS leaves the mask off each line.
  const dest = showMask ? `${formatIp(r.network)}/${r.prefix}` : formatIp(r.network);
  if (r.code === 'C' || r.code === 'L') return [`${code}${dest} is directly connected, ${r.iface}`];
  const via = (x: Route) => {
    if (x.code === 'S') return x.nextHop !== null ? `via ${formatIp(x.nextHop)}` : `is directly connected, ${x.iface}`;
    const age = x.since !== undefined ? `, ${ageText(net.time - x.since)}` : '';
    return `via ${formatIp(x.nextHop!)}${age}${x.iface ? `, ${x.iface}` : ''}`;
  };
  const lines = [`${code}${dest} [${r.distance}/${r.metric}] ${via(r)}`];
  for (const x of group.slice(1)) lines.push(`${' '.repeat(code.length + dest.length + 1)}[${x.distance}/${x.metric}] ${via(x)}`);
  return lines;
}

/** The body of `show ip route` for a set of routes, grouped by classful network like IOS. */
/** `full` = the whole table, when showing a filtered view (`show ip route ospf`): group headers come from it. */
export function showRouteTable(net: Network, table: Route[], header = true, full: Route[] = table): string[] {
  const lines: string[] = [];
  if (header) {
    lines.push(
      'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
      '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area ',
      '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
      '       E1 - OSPF external type 1, E2 - OSPF external type 2',
      '       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2',
      '       ia - IS-IS inter area, * - candidate default, U - per-user static route',
      '       o - ODR, P - periodic downloaded static route, + - replicated route',
      '',
    );
    const def = full.find((r) => r.isDefault);
    lines.push(
      def ? `Gateway of last resort is ${def.nextHop !== null ? formatIp(def.nextHop) : '0.0.0.0'} to network 0.0.0.0` : 'Gateway of last resort is not set',
      '',
    );
  }
  // Same prefix from the same protocol = equal-cost paths, printed together.
  const byPrefix = new Map<string, Route[]>();
  for (const r of table) {
    const k = `${r.network}/${r.prefix}/${r.code}`;
    if (!byPrefix.has(k)) byPrefix.set(k, []);
    byPrefix.get(k)!.push(r);
  }
  const majorOf = (r: Route) => (r.prefix === 0 ? 0 : (r.network & prefixToMask(classfulPrefix(r.network))) >>> 0);
  const groups = new Map<number, Route[][]>();
  for (const g of byPrefix.values()) {
    const major = majorOf(g[0]);
    if (!groups.has(major)) groups.set(major, []);
    groups.get(major)!.push(g);
  }
  // Header facts (subnet and mask counts) for each major network, from the full table.
  const fullStats = new Map<number, { subnets: Set<string>; masks: Set<number> }>();
  for (const r of full) {
    const m = majorOf(r);
    if (!fullStats.has(m)) fullStats.set(m, { subnets: new Set(), masks: new Set() });
    fullStats.get(m)!.subnets.add(`${r.network}/${r.prefix}`);
    fullStats.get(m)!.masks.add(r.prefix);
  }
  for (const major of [...groups.keys()].sort((a, b) => a - b)) {
    const list = groups.get(major)!.sort((a, b) => a[0].network - b[0].network || a[0].prefix - b[0].prefix || (a[0].code === 'L' ? 1 : 0) - (b[0].code === 'L' ? 1 : 0));
    const classful = classfulPrefix(major);
    const stats = fullStats.get(major)!;
    const isSubnetted = [...stats.masks].some((p) => p > classful) && major !== 0;
    if (!isSubnetted) {
      for (const g of list) lines.push(...routeLines(net, g, false));
      continue;
    }
    const masks = stats.masks;
    lines.push(
      masks.size > 1
        ? `      ${formatIp(major)}/${classful} is variably subnetted, ${stats.subnets.size} subnets, ${masks.size} masks`
        : `      ${formatIp(major)}/${[...masks][0]} is subnetted, ${stats.subnets.size} subnets`,
    );
    for (const g of list) lines.push(...routeLines(net, g, true, masks.size > 1));
  }
  return lines;
}

export function showIpRoute(net: Network, device: Device): string[] {
  if (!routes(device)) {
    const gw = device.running.defaultGateway;
    return [
      gw === null ? 'Default gateway is not set' : `Default gateway is ${formatIp(gw)}`,
      '',
      'Host               Gateway           Last Use    Total Uses  Interface',
      'ICMP redirect cache is empty',
    ];
  }
  return showRouteTable(net, routingTable(net, device));
}

export function showArp(net: Network, device: Device): string[] {
  const lines = ['Protocol  Address          Age (min)  Hardware Addr   Type   Interface'];
  const rows: { ip: number; line: string }[] = [];
  for (const i of l3Interfaces(net, device).filter((x) => x.up)) {
    rows.push({ ip: i.address, line: `Internet  ${formatIp(i.address).padEnd(17)}${'-'.padStart(9)}   ${macOf(device, i.name)}  ARPA   ${i.name}` });
  }
  for (const [ip, e] of device.arp) {
    const age = Math.floor((net.time - e.learnedAt) / 60000);
    rows.push({ ip, line: `Internet  ${formatIp(ip).padEnd(17)}${String(age).padStart(9)}   ${e.mac}  ARPA   ${e.iface}` });
  }
  rows.sort((a, b) => a.ip - b.ip);
  return [...lines, ...rows.map((r) => r.line)];
}

// ---- discovery ---------------------------------------------------------------

const CAPABILITY: Record<string, string> = { router: 'R S I', switch: 'S I', l3switch: 'R S I' };

function cdpNeighbors(net: Network, device: Device) {
  const result = [];
  for (const ifc of sortedInterfaces(device.running)) {
    if (!device.hardware[ifc.name] || !net.isUp(device.id, ifc.name)) continue;
    const peerEnd = net.peerOf(device.id, ifc.name);
    if (!peerEnd) continue;
    const peer = net.device(peerEnd.device);
    if (isHostKind(peer.kind)) continue; // hosts don't run CDP
    result.push({ local: ifc.name, peer, peerIface: peerEnd.iface });
  }
  return result;
}

export function showCdpNeighbors(net: Network, device: Device): string[] {
  const lines = [
    'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge',
    '                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone',
    '',
    'Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID',
  ];
  for (const n of cdpNeighbors(net, device)) {
    const hold = 120 + (n.peer.id.length * 7 + n.local.length) % 60;
    lines.push(
      `${n.peer.running.hostname.slice(0, 16).padEnd(17)}${cdpIfName(n.local).padEnd(18)}${String(hold).padEnd(11)}${CAPABILITY[n.peer.kind].padStart(10)}  ${n.peer.model.padEnd(10)}${cdpIfName(n.peerIface)}`,
    );
  }
  return lines;
}

export function showCdpNeighborsDetail(net: Network, device: Device): string[] {
  const lines: string[] = [];
  for (const n of cdpNeighbors(net, device)) {
    const mgmt = l3Interfaces(net, n.peer).find((i) => i.up);
    const caps = n.peer.kind === 'router' ? 'Router Switch IGMP' : n.peer.kind === 'l3switch' ? 'Router Switch IGMP' : 'Switch IGMP';
    lines.push('-------------------------', `Device ID: ${n.peer.running.hostname}`, 'Entry address(es): ');
    if (mgmt) lines.push(`  IP address: ${formatIp(mgmt.address)}`);
    lines.push(
      `Platform: NetSmart ${n.peer.model},  Capabilities: ${caps}`,
      `Interface: ${n.local},  Port ID (outgoing port): ${n.peerIface}`,
      'Holdtime : 137 sec',
      '',
      'Version :',
      ...versionBanner(n.peer).slice(0, 2),
      '',
      'advertisement version: 2',
    );
    const peerIfc = n.peer.running.interfaces[n.peerIface];
    if (peerIfc?.switchport) lines.push(`Native VLAN: ${peerIfc.switchport.nativeVlan}`);
    lines.push('Duplex: full', '');
  }
  return lines;
}

// ---- system ------------------------------------------------------------------

function versionBanner(device: Device): string[] {
  const v = osVersion(device);
  const family = device.model.replace('NS-', '');
  return [
    'NetSmart Internetwork Operating System Software',
    `NSOS (tm) ${family} Software (NS${family}-UNIVERSALK9-M), Version ${v}, RELEASE SOFTWARE (fc2)`,
  ];
}

function uptime(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts = [];
  if (d) parts.push(`${d} day${d === 1 ? '' : 's'}`);
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  return parts.join(', ');
}

export function showVersion(net: Network, device: Device): string[] {
  const gig = Object.keys(device.hardware).filter((n) => n.startsWith('Gigabit')).length;
  const fast = Object.keys(device.hardware).filter((n) => n.startsWith('Fast')).length;
  const lines = [
    ...versionBanner(device),
    'Technical Support: http://www.netsmart.example/techsupport',
    'Copyright (c) 1996-2026 by NetSmart Systems, Inc. "The only networking vendor ever!"',
    '',
    'ROM: System Bootstrap, Version 15.1(4)M4, RELEASE SOFTWARE (fc1)',
    '',
    `${device.running.hostname} uptime is ${uptime(net.time - device.bootedAt)}`,
    'System returned to ROM by power-on',
    `System image file is "flash:${runningImageName(device)}"`,
    '',
    `NetSmart ${device.model} (revision 1.0) with 491520K/32768K bytes of memory.`,
    `Processor board ID ${device.serial}`,
  ];
  if (fast) lines.push(`${fast} FastEthernet interfaces`);
  if (gig) lines.push(`${gig} Gigabit Ethernet interfaces`);
  if (isSwitchKind(device.kind)) lines.push(`Base ethernet MAC Address       : ${device.baseMac}`);
  lines.push('', 'Configuration register is 0x2102');
  return lines;
}

export function showClock(net: Network, device: Device): string[] {
  const { date: d, authoritative } = deviceClock(net, device);
  const day = d.toLocaleString('en-US', { weekday: 'short', timeZone: 'UTC' });
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const hms = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  return [`${authoritative ? '' : '*'}${hms}.${String(d.getUTCMilliseconds()).padStart(3, '0')} UTC ${day} ${month} ${d.getUTCDate()} ${d.getUTCFullYear()}`];
}
