// A console session on one NetSmart device: modes, prompts, the command set, and IOS behaviors
// like falling back to global config from interface mode, `do`, confirmations and domain lookup on typos.

import { cloneConfig, defaultInterfaceConfig } from '../devices';
import { compareIfNames, parentIfName, parseIfName, fullIfName } from '../ifnames';
import { formatIp, maskHex, maskToPrefix, networkOf, broadcastOf, parseIp, inSubnet } from '../ip';
import type { Network } from '../network';
import {
  parseVlanList,
  showArp,
  showCdpNeighbors,
  showCdpNeighborsDetail,
  showClock,
  showInterface,
  showInterfacesStatus,
  showInterfacesTrunk,
  showIpInterfaceBrief,
  showIpRoute,
  showRunning,
  showStartup,
  showVersion,
  showVlanBrief,
  showIpSsh,
  renderConfig,
} from '../render';
import { RemoteClient, type ClientOptions } from '../remote';
import { ping, traceroute } from '../routing';
import type { Device, DeviceKind, InterfaceConfig } from '../types';
import { isSwitchKind } from '../types';
import { CommandTree, complete, formatHelp, help, parse, type Args } from './parser';

export type Mode = 'user' | 'priv' | 'config' | 'if' | 'subif' | 'range' | 'vlan' | 'line';

export interface CliResult {
  output: string[];
  /** Output that appears only after a pause (ping timeouts, DNS lookup on a typo). */
  delayed?: { ms: number; output: string[] };
}

interface Pending {
  prompt: string;
  secret?: boolean;
  handle: (answer: string, out: string[]) => void;
}

interface Ctx {
  s: CliSession;
  net: Network;
  dev: Device;
  out: string[];
  result: CliResult;
  /** Character offset of the command within the typed line (non-zero for `do`). */
  offset: number;
}

const INVALID = "% Invalid input detected at '^' marker.";

// ---- helpers used by commands ----------------------------------------------------

function caret(ctx: Ctx, column: number): void {
  ctx.out.push(' '.repeat(ctx.s.promptText().length + ctx.offset + column) + '^', INVALID, '');
}

function currentIfs(ctx: Ctx): InterfaceConfig[] {
  return ctx.s.ifContext.map((n) => ctx.dev.running.interfaces[n]).filter(Boolean);
}

function commit(ctx: Ctx): void {
  ctx.net.commit();
}

/** Validates an `ip address` assignment like IOS does. Returns an error line or null. */
function checkAddress(dev: Device, ifName: string, addrText: string, maskText: string): string | null {
  const addr = parseIp(addrText)!;
  const mask = parseIp(maskText)!;
  const prefix = maskToPrefix(mask);
  if (prefix === null || prefix === 0) return `Bad mask ${maskHex(mask)} for address ${addrText}`;
  if (prefix < 31 && (addr === networkOf(addr, prefix) || addr === broadcastOf(addr, prefix))) {
    return `Bad mask /${prefix} for address ${addrText}`;
  }
  for (const other of Object.values(dev.running.interfaces)) {
    if (other.name === ifName || !other.ip || other.switchport) continue;
    const p = Math.min(prefix, other.ip.prefix);
    if (inSubnet(addr, other.ip.address, p)) {
      return `% ${formatIp(networkOf(addr, prefix))} overlaps with ${other.name}`;
    }
  }
  return null;
}

/** Expands "fa0/1 - 4, fa0/6" or "g0/1-2" into full interface names. */
function expandRange(dev: Device, spec: string): string[] | null {
  const names: string[] = [];
  for (const part of spec.split(',')) {
    const m = /^\s*([a-zA-Z-]+)\s*(\d+\/)?(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) return null;
    const parsed = parseIfName(`${m[1]}${m[2] ?? ''}${m[3]}`);
    if (!parsed) return null;
    const from = Number(m[3]);
    const to = m[4] ? Number(m[4]) : from;
    if (to < from) return null;
    for (let i = from; i <= to; i++) {
      const name = fullIfName({ type: parsed.type, number: `${m[2] ?? ''}${i}` });
      if (!dev.hardware[name]) return null;
      names.push(name);
    }
  }
  return names;
}

// ---- command trees -----------------------------------------------------------------

const H: Record<string, string> = {
  show: 'Show running system information',
  ping: 'Send echo messages',
  traceroute: 'Trace route to destination',
  enable: 'Turn on privileged commands',
  disable: 'Turn off privileged commands',
  exit: 'Exit from the EXEC',
  logout: 'Exit from the EXEC',
  terminal: 'Set terminal line parameters',
  length: 'Set number of lines on a screen',
  configure: 'Enter configuration mode',
  write: 'Write running configuration to memory, network, or terminal',
  memory: 'Write to NV memory',
  copy: 'Copy from one file to another',
  'running-config': 'Current operating configuration',
  'startup-config': 'Contents of startup configuration',
  erase: 'Erase a filesystem',
  reload: 'Halt and perform a cold restart',
  version: 'System hardware and software status',
  clock: 'Display the system clock',
  ip: 'IP information',
  interface: 'IP interface status and configuration',
  interfaces: 'Interface status and configuration',
  brief: 'Brief summary of IP status and configuration',
  status: 'Show interface line status',
  trunk: 'Show interface trunk information',
  route: 'IP routing table',
  arp: 'ARP table',
  cdp: 'CDP information',
  neighbors: 'CDP neighbor entries',
  detail: 'Show detailed information',
  vlan: 'VTP VLAN status',
  addr: 'Destination address',
  if: 'Interface name (e.g. GigabitEthernet0/1)',
  len: 'Number of lines on screen (0 for no pausing)',
  host: 'Destination host name',
};

const HC: Record<string, string> = {
  hostname: 'Set system\'s network name',
  name: "This system's network name",
  interface: 'Select an interface to configure',
  range: 'interface range command',
  spec: 'Interface range, e.g. fa0/1 - 12',
  vlan: 'Vlan commands',
  id: 'ISL VLAN IDs 1-1005',
  no: 'Negate a command or set its defaults',
  ip: 'Global IP configuration subcommands',
  route: 'Establish static routes',
  net: 'Destination prefix',
  mask: 'Destination prefix mask',
  nh: 'Forwarding router\'s address',
  exitif: 'Exit interface',
  ad: 'Distance metric for this route',
  routing: 'Enable IP routing',
  'default-gateway': 'Specify default gateway (if not routing IP)',
  gw: 'IP address of default gateway',
  'domain-lookup': 'Enable IP Domain Name System hostname translation',
  enable: 'Modify enable password parameters',
  secret: 'Assign the privileged level secret',
  pw: 'The UNENCRYPTED (cleartext) \'enable\' secret',
  banner: 'Define a login banner',
  motd: 'Set Message of the Day banner',
  text: 'c banner-text c, where \'c\' is a delimiting character',
  end: 'Exit from configure mode',
  exit: 'Exit from configure mode',
  do: 'To run exec commands in config mode',
  cmd: 'Exec Command',
};

const HI: Record<string, string> = {
  shutdown: 'Shutdown the selected interface',
  no: 'Negate a command or set its defaults',
  description: 'Interface specific description',
  text: 'Up to 240 characters describing this interface',
  ip: 'Interface Internet Protocol config commands',
  address: 'Set the IP address of an interface',
  addr: 'IP address',
  mask: 'IP subnet mask',
  switchport: 'Set switching mode characteristics',
  mode: 'Set trunking mode of the interface',
  access: 'Set access mode characteristics of the interface',
  trunk: 'Set trunking characteristics of the interface',
  dynamic: 'Set trunking mode to dynamically negotiate access or trunk mode',
  auto: 'Set trunking mode dynamic negotiation parameter to AUTO',
  desirable: 'Set trunking mode dynamic negotiation parameter to DESIRABLE',
  vlan: 'Set VLAN when interface is in access mode',
  native: 'Set trunking native characteristics when interface is in trunking mode',
  allowed: 'Set allowed VLAN characteristics when interface is in trunking mode',
  add: 'add VLANs to the current list',
  remove: 'remove VLANs from the current list',
  except: 'all VLANs except the following',
  all: 'all VLANs',
  none: 'no VLANs',
  list: 'VLAN IDs of the allowed VLANs when this port is in trunking mode',
  encapsulation: 'Set encapsulation type for an interface',
  dot1q: 'Interface uses only 802.1q trunking encapsulation when trunking',
  dot1Q: 'IEEE 802.1Q Virtual LAN',
  speed: 'Configure speed operation.',
  duplex: 'Configure duplex operation.',
  full: 'Force full duplex operation',
  half: 'Force half-duplex operation',
  exit: 'Exit from interface configuration mode',
  end: 'Exit from configure mode',
  do: 'To run exec commands in config mode',
  cmd: 'Exec Command',
  name: 'Ascii name of the VLAN',
  id: 'VLAN ID',
};

type Tree = CommandTree<Ctx>;

function addShows(t: Tree, kind: DeviceKind, privileged: boolean): void {
  t.add('show version', H, (c) => c.out.push(...showVersion(c.net, c.dev)));
  t.add('show clock', H, (c) => c.out.push(...showClock(c.net)));
  t.add('show ip interface brief', H, (c) => c.out.push(...showIpInterfaceBrief(c.net, c.dev)));
  t.add('show interfaces', H, (c) => {
    const ifs = Object.values(c.dev.running.interfaces).sort((a, b) => compareIfNames(a.name, b.name));
    for (const ifc of ifs) c.out.push(...showInterface(c.net, c.dev, ifc));
  });
  t.add('show interfaces <iface:if>', H, (c, a) => {
    const ifc = c.dev.running.interfaces[a.if as string];
    if (!ifc) return caret(c, a['@if'] as number);
    c.out.push(...showInterface(c.net, c.dev, ifc));
  });
  t.add('show ip route', H, (c) => c.out.push(...showIpRoute(c.net, c.dev)));
  t.add('show arp', H, (c) => c.out.push(...showArp(c.net, c.dev)));
  t.add('show ip arp', H, (c) => c.out.push(...showArp(c.net, c.dev)));
  t.add('show cdp neighbors', H, (c) => c.out.push(...showCdpNeighbors(c.net, c.dev)));
  t.add('show cdp neighbors detail', H, (c) => c.out.push(...showCdpNeighborsDetail(c.net, c.dev)));
  t.add('show ip ssh', { ...H, ssh: 'Information on SSH' }, (c) => c.out.push(...showIpSsh(c.dev)));
  if (isSwitchKind(kind)) {
    t.add('show vlan', H, (c) => c.out.push(...showVlanBrief(c.net, c.dev)));
    t.add('show vlan brief', H, (c) => c.out.push(...showVlanBrief(c.net, c.dev)));
    t.add('show interfaces status', H, (c) => c.out.push(...showInterfacesStatus(c.net, c.dev)));
    t.add('show interfaces trunk', H, (c) => c.out.push(...showInterfacesTrunk(c.net, c.dev)));
  }
  if (privileged) {
    t.add('show running-config', H, (c) => c.out.push(...showRunning(c.dev)));
    t.add('show running-config interface <iface:if>', H, (c, a) => {
      const name = a.if as string;
      if (!c.dev.running.interfaces[name]) return caret(c, a['@if'] as number);
      const all = renderConfig(c.dev, c.dev.running);
      const start = all.indexOf(`interface ${name}`);
      const end = all.indexOf('!', start);
      c.out.push('Building configuration...', '', `Current configuration : ${all.slice(start, end).join('\n').length} bytes`, '!');
      c.out.push(...all.slice(start, end + 1), 'end');
    });
    t.add('show startup-config', H, (c) => c.out.push(...showStartup(c.dev)));
  }
}

function addExecCommon(t: Tree): void {
  t.add('ping <ip:addr>', H, (c, a) => runPing(c, a.addr as string));
  t.add('ping <word:host>', H, (c) => c.out.push('% Unrecognized host or address, or protocol not running.', ''));
  t.add('traceroute <ip:addr>', H, (c, a) => runTrace(c, a.addr as string));
  t.add('terminal length <number:len:0-512>', H, () => {});
  t.add('terminal monitor', { ...H, monitor: 'Copy debug output to the current terminal line' }, (c) => {
    if (c.s.isRemote) c.s.monitor = true;
    else c.out.push('% Console already monitors');
  });
  t.add('terminal no monitor', H, (c) => {
    c.s.monitor = false;
  });
  t.add('ssh <line:args>', { ...H, ssh: 'Open a secure shell client connection', args: '-l <user> [-p <port>] <ip>' }, (c, a) =>
    runIosSsh(c, a.args as string),
  );
  t.add('telnet <ip:addr>', { ...H, telnet: 'Open a telnet connection' }, (c, a) => c.s.openRemote({ proto: 'telnet', ip: parseIp(a.addr as string)!, port: 23, user: null }, c.result));
  t.add('telnet <ip:addr> <number:port:1-65535>', H, (c, a) =>
    c.s.openRemote({ proto: 'telnet', ip: parseIp(a.addr as string)!, port: a.port as number, user: null }, c.result),
  );
  t.add('exit', H, (c) => c.s.endSession(c.out));
  t.add('logout', H, (c) => c.s.endSession(c.out));
}

/** IOS client syntax: ssh -l <user> [-p <port>] [-v 2] <ip> */
function runIosSsh(c: Ctx, args: string): void {
  const tokens = args.trim().split(/\s+/);
  let user: string | null = null;
  let port = 22;
  let host: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-l') user = tokens[++i] ?? null;
    else if (t === '-p') port = Number(tokens[++i]);
    else if (t === '-v' || t === '-c' || t === '-m') i++;
    else host = t;
  }
  const ip = host ? parseIp(host) : null;
  if (!user || ip === null || !Number.isInteger(port) || port < 1 || port > 65535) {
    c.out.push('% Usage: ssh -l <username> [-p <port>] <ip address>', '');
    return;
  }
  c.s.openRemote({ proto: 'ssh', ip, port, user }, c.result);
}

function runPing(c: Ctx, addrText: string): void {
  const dest = parseIp(addrText)!;
  const r = ping(c.net, c.dev.id, dest);
  c.out.push('Type escape sequence to abort.', `Sending 5, 100-byte ICMP Echos to ${addrText}, timeout is 2 seconds:`);
  const lines = [r.marks];
  if (r.successes > 0) {
    const min = Math.min(...r.rttMs);
    const max = Math.max(...r.rttMs);
    const avg = Math.round(r.rttMs.reduce((x, y) => x + y, 0) / r.rttMs.length);
    lines.push(`Success rate is ${r.successes * 20} percent (${r.successes}/5), round-trip min/avg/max = ${min}/${avg}/${max} ms`);
  } else {
    lines.push('Success rate is 0 percent (0/5)');
  }
  const timeouts = [...r.marks].filter((m) => m === '.').length;
  c.result.delayed = { ms: 300 + timeouts * 900, output: lines };
}

function runTrace(c: Ctx, addrText: string): void {
  const dest = parseIp(addrText)!;
  const hops = traceroute(c.net, c.dev.id, dest);
  c.out.push('Type escape sequence to abort.', `Tracing the route to ${addrText}`, 'VRF info: (vrf in name/id, vrf out name/id)');
  const lines = hops.map((h) => {
    const n = String(h.ttl).padStart(3);
    if (h.address === null) return `${n}  *    *    * `;
    if (h.unreachable) return `${n} ${formatIp(h.address)} !H  !H  !H `;
    return `${n} ${formatIp(h.address)} ${h.rttMs.map((m) => `${m} msec`).join(' ')}`;
  });
  const silent = hops.filter((h) => h.address === null).length;
  c.result.delayed = { ms: 300 + Math.min(silent, 6) * 900, output: lines };
}

function buildUser(kind: DeviceKind): Tree {
  const t: Tree = new CommandTree();
  t.add('enable', H, (c) => c.s.enable(c.out));
  addExecCommon(t);
  addShows(t, kind, false);
  return t;
}

function save(c: Ctx, out: string[]): void {
  c.dev.startup = cloneConfig(c.dev.running);
  out.push('Building configuration...', '[OK]');
}

function buildPriv(kind: DeviceKind): Tree {
  const t: Tree = new CommandTree();
  addExecCommon(t);
  addShows(t, kind, true);
  t.add('enable', H, () => {});
  t.add('disable', H, (c) => c.s.setMode('user'));
  t.add('configure terminal', { ...H, terminal: 'Configure from the terminal' }, (c) => c.s.enterConfig(c.out));
  t.add('configure', H, (c) =>
    c.s.ask({
      prompt: 'Configuring from terminal, memory, or network [terminal]? ',
      handle: (answer, out) => {
        if (answer.trim() === '' || 'terminal'.startsWith(answer.trim().toLowerCase())) c.s.enterConfig(out);
        else out.push('?Must be "terminal", "memory" or "network"');
      },
    }),
  );
  t.add('write', H, (c) => save(c, c.out));
  t.add('write memory', H, (c) => save(c, c.out));
  t.add('copy running-config startup-config', H, (c) =>
    c.s.ask({
      prompt: 'Destination filename [startup-config]? ',
      handle: (answer, out) => {
        if (answer.trim() && answer.trim() !== 'startup-config') {
          out.push(`%Error opening flash:${answer.trim()} (Permission denied)`);
          return;
        }
        save(c, out);
      },
    }),
  );
  t.add('erase startup-config', H, (c) =>
    c.s.ask({
      prompt: 'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]',
      handle: (answer, out) => {
        if (!isConfirm(answer)) return;
        c.dev.startup = null;
        out.push('[OK]', 'Erase of nvram: complete');
        c.net.log(c.dev.id, '%SYS-7-NV_BLOCK_INIT: Initialized the geometry of nvram');
      },
    }),
  );
  t.add('reload', H, (c) => {
    const proceed = () =>
      c.s.ask({
        prompt: 'Proceed with reload? [confirm]',
        handle: (answer) => {
          if (isConfirm(answer)) c.s.reloadDevice();
        },
      });
    const dirty = !c.dev.startup || JSON.stringify(c.dev.startup) !== JSON.stringify(c.dev.running);
    if (!dirty) return proceed();
    c.s.ask({
      prompt: 'System configuration has been modified. Save? [yes/no]: ',
      handle: (answer, out) => {
        const a = answer.trim().toLowerCase();
        if (a.startsWith('y')) save(c, out);
        else if (!a.startsWith('n')) {
          out.push('% Please answer \'yes\' or \'no\'.');
          return;
        }
        proceed();
      },
    });
  });
  return t;
}

function isConfirm(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === '' || a === 'y' || a === 'yes' || a === 'confirm';
}

function buildConfig(kind: DeviceKind): Tree {
  const t: Tree = new CommandTree();
  const sw = isSwitchKind(kind);
  t.add('hostname <word:name>', HC, (c, a) => {
    const name = a.name as string;
    if (!/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(name)) {
      c.out.push('% Hostname contains one or more illegal characters.');
      return;
    }
    c.dev.running.hostname = name;
  });
  t.add('interface <iface:if>', HC, (c, a) => {
    const name = a.if as string;
    const cfg = c.dev.running;
    if (!cfg.interfaces[name]) {
      const parent = parentIfName(name);
      const isLoopback = name.startsWith('Loopback');
      const vlanMatch = /^Vlan(\d+)$/.exec(name);
      let ok = false;
      if (isLoopback && !parent) ok = true;
      else if (vlanMatch && sw) ok = Number(vlanMatch[1]) >= 1 && Number(vlanMatch[1]) <= 4094;
      else if (parent) ok = !!c.dev.hardware[parent] && !cfg.interfaces[parent]?.switchport;
      if (!ok) return caret(c, a['@if'] as number);
      const created = defaultInterfaceConfig(name, c.dev.kind, !!vlanMatch);
      cfg.interfaces[name] = created;
      commit(c);
    }
    c.s.enterInterfaces([name], parentIfName(name) ? 'subif' : 'if');
  });
  t.add('interface range <line:spec>', HC, (c, a) => {
    const names = expandRange(c.dev, a.spec as string);
    if (!names) return caret(c, a['@spec'] as number);
    c.s.enterInterfaces(names, 'range');
  });
  t.add('no interface <iface:if>', HC, (c, a) => {
    const name = a.if as string;
    if (c.dev.hardware[name] || !c.dev.running.interfaces[name]) {
      c.out.push('% Physical interfaces cannot be deleted');
      return;
    }
    delete c.dev.running.interfaces[name];
    commit(c);
  });
  if (sw) {
    t.add('vlan <number:id:1-4094>', HC, (c, a) => {
      const id = a.id as number;
      if (!c.dev.vlans[id]) {
        c.dev.vlans[id] = { name: `VLAN${String(id).padStart(4, '0')}` };
        commit(c);
      }
      c.s.enterVlan(id);
    });
    t.add('no vlan <number:id:1-4094>', HC, (c, a) => {
      const id = a.id as number;
      if (id === 1 || id >= 1002) {
        c.out.push(`%Default VLAN ${id} may not be deleted.`);
        return;
      }
      delete c.dev.vlans[id];
      commit(c);
    });
    t.add('ip default-gateway <ip:gw>', HC, (c, a) => {
      c.dev.running.defaultGateway = parseIp(a.gw as string);
    });
    t.add('no ip default-gateway', HC, (c) => {
      c.dev.running.defaultGateway = null;
    });
  }
  if (kind === 'router' || kind === 'l3switch') {
    const addRoute = (c: Ctx, a: Args) => {
      const net = parseIp(a.net as string)!;
      const prefix = maskToPrefix(parseIp(a.mask as string)!);
      if (prefix === null || networkOf(net, prefix) !== net) {
        c.out.push('%Inconsistent address and mask');
        return;
      }
      const nextHop = a.nh !== undefined ? parseIp(a.nh as string) : null;
      const exitIf = (a.exitif as string | undefined) ?? null;
      if (exitIf && !c.dev.running.interfaces[exitIf]) return caret(c, a['@exitif'] as number);
      const distance = (a.ad as number | undefined) ?? 1;
      const routes = c.dev.running.staticRoutes;
      const existing = routes.findIndex(
        (r) => r.network === net && r.prefix === prefix && r.nextHop === nextHop && r.exitIf === exitIf,
      );
      const route = { network: net, prefix, nextHop, exitIf, distance };
      if (existing >= 0) routes[existing] = route;
      else routes.push(route);
      commit(c);
    };
    t.add('ip route <ip:net> <mask:mask> <ip:nh>', HC, addRoute);
    t.add('ip route <ip:net> <mask:mask> <ip:nh> <number:ad:1-255>', HC, addRoute);
    t.add('ip route <ip:net> <mask:mask> <iface:exitif>', HC, addRoute);
    t.add('ip route <ip:net> <mask:mask> <iface:exitif> <number:ad:1-255>', HC, addRoute);
    const removeRoute = (c: Ctx, a: Args) => {
      const net = parseIp(a.net as string)!;
      const prefix = maskToPrefix(parseIp(a.mask as string)!);
      const nh = a.nh !== undefined ? parseIp(a.nh as string) : undefined;
      const before = c.dev.running.staticRoutes.length;
      c.dev.running.staticRoutes = c.dev.running.staticRoutes.filter(
        (r) => !(r.network === net && r.prefix === prefix && (nh === undefined || r.nextHop === nh)),
      );
      if (c.dev.running.staticRoutes.length === before) c.out.push('%No matching route to delete');
      commit(c);
    };
    t.add('no ip route <ip:net> <mask:mask>', HC, removeRoute);
    t.add('no ip route <ip:net> <mask:mask> <ip:nh>', HC, removeRoute);
    t.add('ip routing', HC, (c) => {
      c.dev.running.ipRouting = true;
      commit(c);
    });
    t.add('no ip routing', HC, (c) => {
      if (c.dev.kind === 'router') {
        c.out.push('% IP routing cannot be disabled on this platform in the sim');
        return;
      }
      c.dev.running.ipRouting = false;
      commit(c);
    });
  }
  t.add('ip domain-lookup', HC, (c) => {
    c.dev.running.domainLookup = true;
  });
  t.add('no ip domain-lookup', HC, (c) => {
    c.dev.running.domainLookup = false;
  });
  t.add('enable secret <word:pw>', HC, (c, a) => {
    c.dev.running.enableSecret = a.pw as string;
  });
  t.add('no enable secret', HC, (c) => {
    c.dev.running.enableSecret = null;
  });
  t.add('banner motd <line:text>', HC, (c, a) => c.s.startBanner(a.text as string, c.out));
  t.add('no banner motd', HC, (c) => {
    c.dev.running.bannerMotd = null;
  });
  addRemoteAccessConfig(t);
  addConfigNav(t, HC);
  return t;
}

const HS: Record<string, string> = {
  ...HC,
  username: 'Establish User Name Authentication',
  user: 'User name',
  privilege: 'Set user privilege level',
  level: 'User privilege level',
  secret: 'Specify the secret for the user',
  password: 'Specify the password for the user',
  pw: 'The UNENCRYPTED (cleartext) user password',
  'domain-name': 'Define the default domain name',
  domain: 'IP DNS Resolver',
  dname: 'Default domain name',
  crypto: 'Encryption module',
  key: 'Long term key operations',
  generate: 'Generate new keys',
  rsa: 'Generate RSA keys',
  'general-keys': 'Generate a general purpose RSA key pair for signing and encryption',
  modulus: 'Provide number of modulus bits on the command line',
  bits: 'size of the key modulus [360-4096]',
  zeroize: 'Remove keys',
  ssh: 'Configure ssh options',
  version: 'Specify protocol version supported',
  ver: 'Protocol version',
  port: 'Starting (or only) Port number to listen on',
  portnum: 'Port number',
  rotary: 'Specify the rotary group number',
  group: 'Rotary group number',
  'pubkey-chain': 'pubkey-chain',
  line: 'Configure a terminal line',
  console: 'Primary terminal line',
  vty: 'Virtual terminal',
  first: 'First Line number',
  last: 'Last Line number',
};

function addRemoteAccessConfig(t: Tree): void {
  const setUser = (c: Ctx, a: Args, kind: 'secret' | 'password') => {
    const name = a.user as string;
    const existing = c.dev.running.users[name];
    c.dev.running.users[name] = {
      privilege: (a.level as number | undefined) ?? existing?.privilege ?? 1,
      secret: kind === 'secret' ? (a.pw as string) : null,
      password: kind === 'password' ? (a.pw as string) : null,
    };
  };
  t.add('username <word:user> secret <word:pw>', HS, (c, a) => setUser(c, a, 'secret'));
  t.add('username <word:user> password <word:pw>', HS, (c, a) => setUser(c, a, 'password'));
  t.add('username <word:user> privilege <number:level:0-15> secret <word:pw>', HS, (c, a) => setUser(c, a, 'secret'));
  t.add('username <word:user> privilege <number:level:0-15> password <word:pw>', HS, (c, a) => setUser(c, a, 'password'));
  t.add('no username <word:user>', HS, (c, a) => {
    delete c.dev.running.users[a.user as string];
  });

  const setDomain = (c: Ctx, a: Args) => {
    c.dev.running.domainName = a.dname as string;
  };
  t.add('ip domain-name <word:dname>', HS, setDomain);
  t.add('ip domain name <word:dname>', HS, setDomain);
  t.add('no ip domain-name', HS, (c) => {
    c.dev.running.domainName = null;
  });

  const generate = (c: Ctx, bits: number | null) => {
    const cfg = c.dev.running;
    const factoryName = c.dev.kind === 'router' ? 'Router' : 'Switch';
    if (cfg.hostname === factoryName) {
      c.out.push(`% Please define a hostname other than ${factoryName}.`);
      return;
    }
    if (!cfg.domainName) {
      c.out.push('% Please define a domain-name first.');
      return;
    }
    const finish = (size: number, out: string[]) => {
      const hadKeys = cfg.crypto !== null;
      cfg.crypto = { bits: size, serial: (cfg.crypto?.serial ?? 0) + 1 + c.net.rng.int(0, 999) };
      out.push(`% Generating ${size} bit RSA keys, keys will be non-exportable...`, '[OK] (elapsed time was 1 seconds)', '');
      if (!hadKeys) c.net.log(c.dev.id, `%SSH-5-ENABLED: SSH ${cfg.ssh.version === 2 ? '2.0' : '1.99'} has been enabled`);
    };
    const intro = [
      `The name for the keys will be: ${cfg.hostname}.${cfg.domainName}`,
    ];
    if (cfg.crypto) intro.unshift(`% You already have RSA keys defined named ${cfg.hostname}.${cfg.domainName}.`, '% They will be replaced.', '');
    c.out.push(...intro);
    if (bits !== null) {
      finish(bits, c.out);
      return;
    }
    c.out.push(
      'Choose the size of the key modulus in the range of 360 to 4096 for your',
      '  General Purpose Keys. Choosing a key modulus greater than 512 may take',
      '  a few minutes.',
      '',
    );
    c.s.ask({
      prompt: 'How many bits in the modulus [512]: ',
      handle: (answer, out) => {
        const n = answer.trim() === '' ? 512 : Number(answer.trim());
        if (!Number.isInteger(n) || n < 360 || n > 4096) {
          out.push('% Key modulus size must be between 360 and 4096 inclusive');
          return;
        }
        finish(n, out);
      },
    });
  };
  t.add('crypto key generate rsa', HS, (c) => generate(c, null));
  t.add('crypto key generate rsa modulus <number:bits:360-4096>', HS, (c, a) => generate(c, a.bits as number));
  t.add('crypto key generate rsa general-keys modulus <number:bits:360-4096>', HS, (c, a) => generate(c, a.bits as number));
  t.add('crypto key zeroize rsa', HS, (c) =>
    c.s.ask({
      prompt: '% All keys will be removed.\n% All router certs issued using these keys will also be removed.\nDo you really want to remove these keys? [yes/no]: ',
      handle: (answer) => {
        if (!answer.trim().toLowerCase().startsWith('y') || !c.dev.running.crypto) return;
        c.dev.running.crypto = null;
        c.net.log(c.dev.id, '%SSH-5-DISABLED: SSH 1.99 has been disabled');
      },
    }),
  );

  t.add('ip ssh version <number:ver:1-2>', HS, (c, a) => {
    const v = a.ver as 1 | 2;
    const crypto = c.dev.running.crypto;
    if (v === 2 && crypto && crypto.bits < 768) {
      c.out.push('Please create RSA keys (of atleast 768 bits size) to enable SSH v2.');
    }
    c.dev.running.ssh.version = v;
  });
  t.add('no ip ssh version', HS, (c) => {
    c.dev.running.ssh.version = null;
  });
  t.add('ip ssh port <number:portnum:2000-10000> rotary <number:group:0-127>', HS, (c, a) => {
    c.dev.running.ssh.port = a.portnum as number;
    c.dev.running.ssh.rotary = a.group as number;
  });
  t.add('no ip ssh port', HS, (c) => {
    c.dev.running.ssh.port = 22;
    c.dev.running.ssh.rotary = null;
  });
  t.add('no ip ssh pubkey-chain', HS, (c) => {
    c.dev.running.authorizedKeys = [];
  });

  t.add('line console <number:first:0-0>', HS, (c) => c.s.enterLine('con'));
  t.add('line vty <number:first:0-15> <number:last:0-15>', HS, (c) => c.s.enterLine('vty'));
}

const HL: Record<string, string> = {
  password: 'Set a password',
  pw: 'The UNENCRYPTED (cleartext) line password',
  login: 'Enable password checking',
  local: 'Local password checking',
  no: 'Negate a command or set its defaults',
  transport: 'Define transport protocols for line',
  input: 'Define which protocols to use when connecting to the terminal server',
  ssh: 'TCP/IP SSH protocol',
  telnet: 'TCP/IP Telnet protocol',
  all: 'All protocols',
  none: 'No protocols',
  logging: 'Modify message logging facilities',
  synchronous: 'Synchronized message output',
  rotary: 'Add line to a rotary group',
  group: 'Rotary group to add line to',
  exit: 'Exit from line configuration mode',
  end: 'Exit from configure mode',
  do: 'To run exec commands in config mode',
  cmd: 'Exec Command',
};

function buildLineMode(): Tree {
  const t: Tree = new CommandTree();
  const line = (c: Ctx) => c.dev.running.lines[c.s.lineContext!];
  t.add('password <word:pw>', HL, (c, a) => void (line(c).password = a.pw as string));
  t.add('no password', HL, (c) => void (line(c).password = null));
  t.add('login', HL, (c) => {
    if (!line(c).password) c.out.push('% Login disabled on line until \'password\' is set');
    line(c).login = 'line';
  });
  t.add('login local', HL, (c) => void (line(c).login = 'local'));
  t.add('no login', HL, (c) => void (line(c).login = 'none'));
  const transport = (ssh: boolean, telnet: boolean) => (c: Ctx) => {
    if (c.s.lineContext === 'con') return caret(c, 0);
    line(c).transport = { ssh, telnet };
  };
  t.add('transport input ssh', HL, transport(true, false));
  t.add('transport input telnet', HL, transport(false, true));
  t.add('transport input ssh telnet', HL, transport(true, true));
  t.add('transport input telnet ssh', HL, transport(true, true));
  t.add('transport input all', HL, transport(true, true));
  t.add('transport input none', HL, transport(false, false));
  t.add('logging synchronous', HL, (c) => void (line(c).loggingSynchronous = true));
  t.add('no logging synchronous', HL, (c) => void (line(c).loggingSynchronous = false));
  t.add('rotary <number:group:0-127>', HL, (c, a) => void (line(c).rotary = a.group as number));
  t.add('no rotary', HL, (c) => void (line(c).rotary = null));
  addConfigNav(t, HL);
  return t;
}

function addConfigNav(t: Tree, help: Record<string, string>): void {
  t.add('end', help, (c) => c.s.endConfig());
  t.add('exit', help, (c) => c.s.exitMode());
  t.add('do <line:cmd>', help, (c, a) => c.s.runExecFromConfig(a.cmd as string, c, a['@cmd'] as number));
}

function buildInterface(kind: DeviceKind, mode: 'if' | 'subif' | 'range'): Tree {
  const t: Tree = new CommandTree();
  const each = (fn: (c: Ctx, ifc: InterfaceConfig, a: Args) => string | void) => (c: Ctx, a: Args) => {
    for (const ifc of currentIfs(c)) {
      const err = fn(c, ifc, a);
      if (err) {
        c.out.push(err);
        break;
      }
    }
    commit(c);
  };
  t.add('shutdown', HI, each((_c, ifc) => void (ifc.shutdown = true)));
  t.add('no shutdown', HI, each((_c, ifc) => void (ifc.shutdown = false)));
  t.add('description <line:text>', HI, each((_c, ifc, a) => void (ifc.description = (a.text as string).slice(0, 240))));
  t.add('no description', HI, each((_c, ifc) => void (ifc.description = null)));

  if (mode !== 'range') {
    t.add('ip address <ip:addr> <mask:mask>', HI, each((c, ifc, a) => {
      if (ifc.switchport) return '% IP addresses may not be configured on L2 links.';
      if (parentIfName(ifc.name) && !ifc.encapsulation) {
        return '% Configuring IP routing on a LAN subinterface is only allowed if that\nsubinterface is already configured as part of an IEEE 802.10, IEEE 802.1Q,\nor ISL vLAN.';
      }
      const err = checkAddress(c.dev, ifc.name, a.addr as string, a.mask as string);
      if (err) return err;
      ifc.ip = { address: parseIp(a.addr as string)!, prefix: maskToPrefix(parseIp(a.mask as string)!)! };
    }));
  }
  t.add('no ip address', HI, each((_c, ifc) => void (ifc.ip = null)));

  if (mode === 'subif') {
    t.add('encapsulation dot1Q <number:id:1-4094>', HI, each((_c, ifc, a) => void (ifc.encapsulation = { vlan: a.id as number, native: false })));
    t.add('encapsulation dot1Q <number:id:1-4094> native', HI, each((_c, ifc, a) => void (ifc.encapsulation = { vlan: a.id as number, native: true })));
  }

  if (mode !== 'subif') {
    t.add('speed auto', HI, each((_c, ifc) => void (ifc.speed = 'auto')));
    t.add('speed 10', HI, each((_c, ifc) => void (ifc.speed = 10)));
    t.add('speed 100', HI, each((_c, ifc) => void (ifc.speed = 100)));
    t.add('speed 1000', HI, each((c, ifc) => {
      if (c.dev.hardware[ifc.name]?.maxSpeed !== 1000) return INVALID;
      ifc.speed = 1000;
    }));
    t.add('duplex auto', HI, each((_c, ifc) => void (ifc.duplex = 'auto')));
    t.add('duplex full', HI, each((_c, ifc) => void (ifc.duplex = 'full')));
    t.add('duplex half', HI, each((_c, ifc) => void (ifc.duplex = 'half')));
  }

  if (isSwitchKind(kind) && mode !== 'subif') {
    const needSp = (fn: (c: Ctx, ifc: InterfaceConfig, a: Args) => string | void) =>
      each((c, ifc, a) => (ifc.switchport ? fn(c, ifc, a) : INVALID));
    const setMode = (m: 'access' | 'trunk' | 'dynamic auto' | 'dynamic desirable') =>
      needSp((c, ifc) => {
        if (m === 'trunk' && c.dev.kind === 'l3switch' && ifc.switchport!.trunkEncapsulation === 'auto') {
          return 'Command rejected: An interface whose trunk encapsulation is "Auto" can not be configured to "trunk" mode.';
        }
        ifc.switchport!.mode = m;
      });
    t.add('switchport mode access', HI, setMode('access'));
    t.add('switchport mode trunk', HI, setMode('trunk'));
    t.add('switchport mode dynamic auto', HI, setMode('dynamic auto'));
    t.add('switchport mode dynamic desirable', HI, setMode('dynamic desirable'));
    t.add('switchport access vlan <number:id:1-4094>', HI, needSp((c, ifc, a) => {
      const id = a.id as number;
      if (!c.dev.vlans[id]) {
        c.out.push(`% Access VLAN does not exist. Creating vlan ${id}`);
        c.dev.vlans[id] = { name: `VLAN${String(id).padStart(4, '0')}` };
      }
      ifc.switchport!.accessVlan = id;
    }));
    t.add('no switchport access vlan', HI, needSp((_c, ifc) => void (ifc.switchport!.accessVlan = 1)));
    t.add('switchport trunk native vlan <number:id:1-4094>', HI, needSp((_c, ifc, a) => void (ifc.switchport!.nativeVlan = a.id as number)));
    t.add('no switchport trunk native vlan', HI, needSp((_c, ifc) => void (ifc.switchport!.nativeVlan = 1)));
    const allowed = (op: 'set' | 'add' | 'remove' | 'except') =>
      needSp((_c, ifc, a) => {
        const list = parseVlanList(a.list as string);
        if (!list) return '% Invalid VLAN list';
        const sp = ifc.switchport!;
        const current = sp.allowedVlans === 'all' ? range(1, 4094) : sp.allowedVlans;
        let next: number[];
        if (op === 'set') next = list;
        else if (op === 'add') next = [...current, ...list];
        else if (op === 'remove') next = current.filter((v) => !list.includes(v));
        else next = range(1, 4094).filter((v) => !list.includes(v));
        next = [...new Set(next)].sort((x, y) => x - y);
        sp.allowedVlans = next.length === 4094 ? 'all' : next;
      });
    t.add('switchport trunk allowed vlan <word:list>', HI, allowed('set'));
    t.add('switchport trunk allowed vlan add <word:list>', HI, allowed('add'));
    t.add('switchport trunk allowed vlan remove <word:list>', HI, allowed('remove'));
    t.add('switchport trunk allowed vlan except <word:list>', HI, allowed('except'));
    t.add('switchport trunk allowed vlan all', HI, needSp((_c, ifc) => void (ifc.switchport!.allowedVlans = 'all')));
    t.add('switchport trunk allowed vlan none', HI, needSp((_c, ifc) => void (ifc.switchport!.allowedVlans = [])));
    t.add('no switchport trunk allowed vlan', HI, needSp((_c, ifc) => void (ifc.switchport!.allowedVlans = 'all')));
    if (kind === 'l3switch') {
      t.add('switchport trunk encapsulation dot1q', HI, needSp((_c, ifc) => void (ifc.switchport!.trunkEncapsulation = 'dot1q')));
      t.add('no switchport', HI, each((c, ifc) => {
        if (!c.dev.hardware[ifc.name]) return INVALID;
        ifc.switchport = null;
        ifc.ip = null;
      }));
      t.add('switchport', HI, each((c, ifc) => {
        if (!c.dev.hardware[ifc.name] || ifc.switchport) return;
        ifc.switchport = defaultInterfaceConfig(ifc.name, c.dev.kind, false).switchport;
        ifc.ip = null;
      }));
    }
  }
  addConfigNav(t, HI);
  return t;
}

function range(from: number, to: number): number[] {
  const r: number[] = [];
  for (let i = from; i <= to; i++) r.push(i);
  return r;
}

function buildVlanMode(): Tree {
  const t: Tree = new CommandTree();
  t.add('name <word:name>', HI, (c, a) => {
    const vlan = c.dev.vlans[c.s.vlanContext!];
    if (vlan) vlan.name = (a.name as string).slice(0, 32);
  });
  t.add('no name', HI, (c) => {
    const id = c.s.vlanContext!;
    if (c.dev.vlans[id]) c.dev.vlans[id].name = `VLAN${String(id).padStart(4, '0')}`;
  });
  addConfigNav(t, HI);
  return t;
}

interface Trees {
  user: Tree;
  priv: Tree;
  config: Tree;
  if: Tree;
  subif: Tree;
  range: Tree;
  vlan: Tree;
  line: Tree;
}

const treeCache = new Map<DeviceKind, Trees>();

export function treesFor(kind: DeviceKind): Trees {
  let trees = treeCache.get(kind);
  if (!trees) {
    trees = {
      user: buildUser(kind),
      priv: buildPriv(kind),
      config: buildConfig(kind),
      if: buildInterface(kind, 'if'),
      subif: buildInterface(kind, 'subif'),
      range: buildInterface(kind, 'range'),
      vlan: buildVlanMode(),
      line: buildLineMode(),
    };
    treeCache.set(kind, trees);
  }
  return trees;
}

// ---- the session -------------------------------------------------------------------

export class CliSession {
  mode: Mode = 'user';
  ifContext: string[] = [];
  vlanContext: number | null = null;
  private pending: Pending | null = null;
  /** After `exit` at the EXEC, the console waits for RETURN. */
  private idle = false;
  private wasBooting = false;
  private enableAttempts = 0;
  private bannerBuffer: { delim: string; lines: string[] } | null = null;
  lineContext: 'con' | 'vty' | null = null;
  /** True for SSH/Telnet (vty) sessions. */
  readonly isRemote: boolean;
  /** `terminal monitor`: show log messages on a vty session. */
  monitor = false;
  /** A vty session ends with `exit`; the client then closes the connection. */
  closed = false;
  /** An outbound SSH/Telnet connection made from this session. */
  private client: RemoteClient | null = null;
  private lastLogSeq: number;
  private readonly remoteUser: string | null;

  constructor(
    readonly net: Network,
    readonly deviceId: string,
    opts: { remote?: { user: string; privilege: number } } = {},
  ) {
    this.isRemote = !!opts.remote;
    this.remoteUser = opts.remote?.user ?? null;
    if (opts.remote && opts.remote.privilege >= 15) this.mode = 'priv';
    this.lastLogSeq = net.lastLogSeq;
  }

  get device(): Device {
    return this.net.device(this.deviceId);
  }

  get booting(): boolean {
    return !this.net.isOnline(this.device);
  }

  /** The prompt shown before user input (or the pending question). */
  promptText(): string {
    if (this.client) return this.client.promptText();
    if (this.pending) return this.pending.prompt;
    if (this.idle) return '';
    const host = this.device.running.hostname;
    switch (this.mode) {
      case 'user':
        return `${host}>`;
      case 'priv':
        return `${host}#`;
      case 'config':
        return `${host}(config)#`;
      case 'if':
        return `${host}(config-if)#`;
      case 'subif':
        return `${host}(config-subif)#`;
      case 'range':
        return `${host}(config-if-range)#`;
      case 'vlan':
        return `${host}(config-vlan)#`;
      case 'line':
        return `${host}(config-line)#`;
    }
  }

  get secretInput(): boolean {
    if (this.client) return this.client.secretInput;
    return !!this.pending?.secret;
  }

  /** Called by the UI each frame; returns messages to print when boot finishes. */
  checkBoot(): string[] {
    if (this.isRemote) return [];
    if (this.booting) {
      this.wasBooting = true;
      return [];
    }
    if (this.wasBooting) {
      this.wasBooting = false;
      this.reset();
      this.idle = true;
      return ['', `${this.device.running.hostname} con0 is now available`, '', 'Press RETURN to get started!', ''];
    }
    return [];
  }

  private reset(): void {
    this.mode = 'user';
    this.ifContext = [];
    this.vlanContext = null;
    this.pending = null;
    this.bannerBuffer = null;
    this.lineContext = null;
    this.client = null;
  }

  input(line: string): CliResult {
    if (this.client) {
      const r = this.client.input(line);
      if (this.client.done) this.client = null;
      return r;
    }
    const result: CliResult = { output: [] };
    if (this.booting) return result;
    const out = result.output;
    if (this.bannerBuffer) {
      this.continueBanner(line);
      return result;
    }
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      p.handle(line, out);
      return result;
    }
    if (this.idle) {
      this.idle = false;
      if (this.device.running.bannerMotd) out.push('', this.device.running.bannerMotd, '');
      this.consoleLogin(out);
      return result;
    }
    if (!line.trim()) return result;
    this.execute(line, result, 0);
    return result;
  }

  private tree(mode: Mode = this.mode): Tree {
    return treesFor(this.device.kind)[mode];
  }

  private execute(line: string, result: CliResult, offset: number): void {
    const out = result.output;
    const ctx: Ctx = { s: this, net: this.net, dev: this.device, out, result, offset };
    let parsed = parse(this.tree(), line);
    const subMode = this.mode !== 'user' && this.mode !== 'priv' && this.mode !== 'config';
    if (!parsed.ok && subMode) {
      // IOS tries the parent (global config) mode when a command isn't valid in a sub-mode.
      const parent = parse(this.tree('config'), line);
      if (parent.ok) {
        this.mode = 'config';
        parsed = parent;
      }
    }
    if (parsed.ok) {
      parsed.node.run!(ctx, parsed.args);
      return;
    }
    if (parsed.error === 'ambiguous') {
      out.push(`% Ambiguous command:  "${parsed.text}"`);
      return;
    }
    if (parsed.error === 'incomplete') {
      out.push('% Incomplete command.', '');
      return;
    }
    const tokens = line.trim().split(/\s+/);
    const isExec = this.mode === 'user' || this.mode === 'priv';
    if (isExec && tokens.length === 1 && offset === 0) {
      // A single unknown word at the EXEC is treated as a hostname to telnet to.
      if (this.device.running.domainLookup) {
        out.push(`Translating "${tokens[0]}"...domain server (255.255.255.255)`);
        result.delayed = { ms: 4000, output: ['% Unknown command or computer name, or unable to find computer address'] };
      } else {
        out.push('% Unknown command or computer name, or unable to find computer address');
      }
      return;
    }
    caret(ctx, parsed.caret);
  }

  /** "?" pressed with the given partial line. */
  help(line: string): string[] {
    if (this.client) return this.client.help(line);
    if (this.booting || this.pending || this.idle) return [];
    const trees = [this.tree()];
    const h = help(trees[0], line);
    if (!h || h.lines.length === 0) {
      if (line.trim() === '') return [];
      return ['% Unrecognized command'];
    }
    return formatHelp(h.lines, h.partial);
  }

  /** Tab pressed: returns the completed line, or the same line if nothing to complete. */
  complete(line: string): string {
    if (this.client) return this.client.complete(line);
    if (this.pending || this.idle) return line;
    return complete(this.tree(), line) ?? (this.mode !== 'config' && this.mode !== 'user' && this.mode !== 'priv' ? complete(this.tree('config'), line) : null) ?? line;
  }

  /** Ctrl+Z */
  ctrlZ(): string[] {
    if (this.client) return this.client.ctrlZ();
    if (this.mode === 'user' || this.mode === 'priv' || this.pending) return [];
    this.endConfig();
    return [];
  }

  // ---- mode transitions used by commands ----

  setMode(mode: Mode): void {
    this.mode = mode;
  }

  ask(p: Pending): void {
    this.pending = p;
  }

  enable(out: string[]): void {
    const secret = this.device.running.enableSecret;
    if (!secret && this.isRemote) {
      // Over SSH/Telnet, IOS refuses `enable` until an enable secret exists.
      out.push('% No password set', '');
      return;
    }
    if (!secret) {
      this.mode = 'priv';
      return;
    }
    this.enableAttempts = 0;
    const tryPassword = () =>
      this.ask({
        prompt: 'Password: ',
        secret: true,
        handle: (answer, o) => {
          if (answer === this.device.running.enableSecret) {
            this.mode = 'priv';
            return;
          }
          this.enableAttempts++;
          if (this.enableAttempts >= 3) o.push('% Bad secrets', '');
          else tryPassword();
        },
      });
    tryPassword();
  }

  enterConfig(out: string[]): void {
    out.push('Enter configuration commands, one per line.  End with CNTL/Z.');
    this.mode = 'config';
  }

  enterInterfaces(names: string[], mode: 'if' | 'subif' | 'range'): void {
    this.ifContext = names;
    this.mode = mode;
  }

  enterLine(which: 'con' | 'vty'): void {
    this.lineContext = which;
    this.mode = 'line';
  }

  /** Console login after RETURN, if `line con 0` has `login` configured. */
  private consoleLogin(out: string[]): void {
    const con = this.device.running.lines.con;
    if (con.login === 'none' || (con.login === 'line' && !con.password)) return;
    out.push('User Access Verification', '');
    let attempts = 0;
    let user = '';
    const askPassword = () =>
      this.ask({
        prompt: 'Password: ',
        secret: true,
        handle: (answer, o) => {
          const u = this.device.running.users[user];
          const ok = con.login === 'local' ? !!u && (u.secret ?? u.password) === answer : answer === con.password;
          if (ok) {
            if (con.login === 'local' && u.privilege >= 15) this.mode = 'priv';
            return;
          }
          attempts++;
          if (attempts >= 3) {
            o.push(con.login === 'local' ? '% Login invalid' : '% Bad passwords', '');
            this.idle = true;
            return;
          }
          if (con.login === 'local') {
            o.push('% Login invalid', '');
            askUser();
          } else askPassword();
        },
      });
    const askUser = () =>
      this.ask({
        prompt: 'Username: ',
        handle: (answer) => {
          user = answer.trim();
          askPassword();
        },
      });
    if (con.login === 'local') askUser();
    else askPassword();
  }

  /** Starts an outbound SSH/Telnet connection from this device. */
  openRemote(opts: Omit<ClientOptions, 'style'>, result: CliResult): void {
    const client = new RemoteClient(this.net, this.deviceId, { ...opts, style: 'ios' });
    const r = client.start();
    result.output.push(...r.output);
    result.delayed = r.delayed;
    if (!client.done) this.client = client;
  }

  /** New log lines for this terminal: always on the console, on vty only with `terminal monitor`. */
  pollLogs(): string[] {
    if (this.client) {
      const lines = this.client.poll();
      if (this.client.done) this.client = null;
      return lines;
    }
    const logs = this.net.logsSince(this.deviceId, this.lastLogSeq);
    if (!logs.length) return [];
    this.lastLogSeq = logs[logs.length - 1].seq;
    if (this.booting || (this.isRemote && !this.monitor)) return [];
    return logs.map((l) => `${this.net.formatLogTime(l.time)}: ${l.message}`);
  }

  enterVlan(id: number): void {
    this.vlanContext = id;
    this.mode = 'vlan';
  }

  exitMode(): void {
    if (this.mode === 'config') this.endConfig();
    else this.mode = 'config';
  }

  endConfig(): void {
    this.mode = 'priv';
    this.ifContext = [];
    this.vlanContext = null;
    this.lineContext = null;
    const by = this.isRemote ? `${this.remoteUser || 'unknown'} on vty0` : 'console';
    this.net.log(this.deviceId, `%SYS-5-CONFIG_I: Configured from console by ${by}`);
  }

  endSession(out: string[]): void {
    if (this.isRemote) {
      this.closed = true;
      return;
    }
    this.reset();
    this.idle = true;
    out.push('', `${this.device.running.hostname} con0 is now available`, '', '', '', '', '', 'Press RETURN to get started.', '');
  }

  reloadDevice(): void {
    this.reset();
    this.net.reload(this.deviceId);
    this.wasBooting = true;
  }

  runExecFromConfig(command: string, ctx: Ctx, offset: number): void {
    const saved = this.mode;
    const parsed = parse(this.tree('priv'), command);
    if (!parsed.ok) {
      if (parsed.error === 'invalid') caret(ctx, offset + parsed.caret);
      else if (parsed.error === 'incomplete') ctx.out.push('% Incomplete command.', '');
      else ctx.out.push(`% Ambiguous command:  "${parsed.text}"`);
      return;
    }
    // `do` cannot change modes (e.g. "do disable" is ignored in config mode).
    parsed.node.run!({ ...ctx, offset: ctx.offset + offset }, parsed.args);
    this.mode = saved;
  }

  startBanner(text: string, out: string[]): void {
    const delim = text[0];
    const rest = text.slice(1);
    const close = rest.indexOf(delim);
    if (close >= 0) {
      this.device.running.bannerMotd = rest.slice(0, close);
      return;
    }
    out.push(`Enter TEXT message.  End with the character '${delim}'.`);
    this.bannerBuffer = { delim, lines: rest ? [rest] : [] };
  }

  private continueBanner(line: string): void {
    const buf = this.bannerBuffer!;
    const close = line.indexOf(buf.delim);
    if (close < 0) {
      buf.lines.push(line);
      return;
    }
    buf.lines.push(line.slice(0, close));
    this.device.running.bannerMotd = buf.lines.join('\n').replace(/^\n+|\n+$/g, '');
    this.bannerBuffer = null;
  }

  /** Prompt to show while typing a multi-line banner. */
  get inBanner(): boolean {
    return this.bannerBuffer !== null;
  }
}

