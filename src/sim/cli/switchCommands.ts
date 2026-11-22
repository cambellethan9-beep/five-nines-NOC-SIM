// Switching commands: spanning tree (global and per port), port security, EtherChannel, errdisable recovery,
// VTP, and their show/clear commands.

import { formatIp } from '../ip';
import { shortIfName } from '../ifnames';
import { DEFAULT_STP, DEFAULT_VTP, bridgePriority, stpOf, vtpOf } from '../l2';
import { parseVlanList, formatVlanList } from '../render';
import type { ChannelMode, InterfaceConfig, PortSecurity, SwitchStp } from '../types';
import { caret, commit, type Ctx, type Tree } from './context';
import type { Args } from './parser';

const HW: Record<string, string> = {
  'spanning-tree': 'Spanning Tree Subsystem',
  mode: 'Spanning tree operating mode',
  pvst: 'Per-Vlan spanning tree mode',
  'rapid-pvst': 'Per-Vlan rapid spanning tree mode',
  vlan: 'VLAN Switch Spanning Tree',
  list: 'vlan range, example: 1,3-5,7,9-11',
  priority: 'Set the bridge priority for the spanning tree',
  prio: 'bridge priority in increments of 4096',
  root: 'Configure switch as root',
  primary: 'Configure this switch as primary root for this spanning tree',
  secondary: 'Configure switch as secondary root',
  portfast: 'Spanning tree portfast options',
  default: 'Enable portfast by default on all access ports',
  bpduguard: 'Don\'t accept BPDUs on this interface',
  bpdufilter: 'Don\'t send or receive BPDUs on this interface',
  loopguard: 'Spanning tree loopguard options',
  enable: 'Enable',
  disable: 'Disable',
  trunk: 'Enable portfast on the interface even in trunk mode',
  guard: 'Change an interface\'s spanning tree guard mode',
  loop: 'Set guard mode to loop guard on interface',
  none: 'Set guard mode to none',
  cost: 'Change an interface\'s spanning tree port path cost',
  n: 'value',
  'port-priority': 'Change an interface\'s spanning tree port priority',
  switchport: 'Set switching mode characteristics',
  'port-security': 'Security related command',
  maximum: 'Max secure addresses',
  violation: 'Security violation mode',
  protect: 'Security violation protect mode',
  restrict: 'Security violation restrict mode',
  shutdown: 'Security violation shutdown mode',
  'mac-address': 'Secure mac address',
  sticky: 'Configure dynamic secure addresses as sticky',
  mac: '48 bit mac address',
  'channel-group': 'Etherchannel/port bundling configuration',
  group: 'Channel group number',
  on: 'Enable Etherchannel only',
  active: 'Enable LACP unconditionally',
  passive: 'Enable LACP only if a LACP device is detected',
  desirable: 'Enable PAgP unconditionally',
  auto: 'Enable PAgP only if a PAgP device is detected',
  errdisable: 'Error disable',
  recovery: 'Error disable recovery',
  cause: 'Enable error disable recovery for application',
  why: 'all | bpduguard | psecure-violation | ...',
  interval: 'Error disable recovery timer value',
  secs: 'timer-interval(sec)',
  vtp: 'Configure global VTP state',
  server: 'Set the device to server mode',
  client: 'Set the device to client mode',
  transparent: 'Set the device to transparent mode',
  off: 'Set the device to off mode',
  domain: 'Set the name of the VTP administrative domain.',
  dname: 'The ascii name for the VTP administrative domain.',
  password: 'Set the password for the VTP administrative domain',
  pw: 'The ascii password for the VTP administrative domain.',
  version: 'Set the administrative domain to permit Version 1/2/3 VTP',
  ver: 'Set the administrative domain VTP version number',
  no: 'Negate a command or set its defaults',
  show: 'Show running system information',
  summary: 'Summary of port states',
  inconsistentports: 'Show inconsistent ports',
  etherchannel: 'EtherChannel information',
  lacp: 'LACP information',
  pagp: 'Port channel information',
  neighbor: 'Neighbor information',
  address: 'Show secure address',
  interface: 'Show secure interface',
  if: 'Interface name',
  status: 'VTP domain status',
  clear: 'Reset functions',
  all: 'All',
};

const stp = (c: Ctx): SwitchStp => (c.dev.running.stp ??= structuredClone(DEFAULT_STP));

function vlans(c: Ctx, a: Args, keyName = 'list'): number[] | null {
  const list = parseVlanList(String(a[keyName]));
  if (!list || !list.length || list.some((v) => v < 1 || v > 4094)) {
    caret(c, a[`@${keyName}`] as number);
    return null;
  }
  return list;
}

/** Bumps the VTP revision on a server (called whenever the VLAN database changes). */
export function vtpChanged(c: Ctx): void {
  if (vtpOf(c.dev).mode === 'server') c.dev.vtpRevision = (c.dev.vtpRevision ?? 0) + 1;
}

export function addSwitchGlobal(t: Tree): void {
  t.add('spanning-tree mode pvst', HW, (c) => void ((stp(c).mode = 'pvst'), commit(c)));
  t.add('spanning-tree mode rapid-pvst', HW, (c) => void ((stp(c).mode = 'rapid-pvst'), commit(c)));
  const setPrio = (c: Ctx, list: number[], priority: number) => {
    const s = stp(c);
    s.priorities = s.priorities.map((e) => ({ ...e, vlans: e.vlans.filter((v) => !list.includes(v)) })).filter((e) => e.vlans.length);
    s.priorities.push({ vlans: list, priority });
    commit(c);
  };
  t.add('spanning-tree vlan <word:list> priority <number:prio:0-61440>', HW, (c, a) => {
    const list = vlans(c, a);
    if (!list) return;
    const p = a.prio as number;
    if (p % 4096) {
      c.out.push('% Bridge Priority must be in increments of 4096.', '% Allowed values are: ', '  0     4096  8192  12288 16384 20480 24576 28672', '  32768 36864 40960 45056 49152 53248 57344 61440');
      return;
    }
    setPrio(c, list, p);
  });
  t.add('spanning-tree vlan <word:list> root primary', HW, (c, a) => {
    const list = vlans(c, a);
    if (list) setPrio(c, list, 24576);
  });
  t.add('spanning-tree vlan <word:list> root secondary', HW, (c, a) => {
    const list = vlans(c, a);
    if (list) setPrio(c, list, 28672);
  });
  t.add('no spanning-tree vlan <word:list> priority', HW, (c, a) => {
    const list = vlans(c, a);
    if (!list) return;
    const s = stp(c);
    s.priorities = s.priorities.map((e) => ({ ...e, vlans: e.vlans.filter((v) => !list.includes(v)) })).filter((e) => e.vlans.length);
    commit(c);
  });
  t.add('no spanning-tree vlan <word:list>', HW, (c, a) => {
    const list = vlans(c, a);
    if (!list) return;
    const s = stp(c);
    s.disabled = [...new Set([...s.disabled, ...list])].sort((x, y) => x - y);
    commit(c);
  });
  t.add('spanning-tree vlan <word:list>', HW, (c, a) => {
    const list = vlans(c, a);
    if (!list) return;
    stp(c).disabled = stp(c).disabled.filter((v) => !list.includes(v));
    commit(c);
  });
  const flag = (k: 'portfastDefault' | 'bpduguardDefault' | 'bpdufilterDefault' | 'loopguardDefault', v: boolean) => (c: Ctx) => {
    stp(c)[k] = v;
    if (k === 'portfastDefault' && v) {
      c.out.push(
        '%Warning: this command enables portfast by default on all interfaces. You',
        ' should now disable portfast explicitly on switched ports leading to hubs,',
        ' switches and bridges as they may create temporary bridging loops.',
      );
    }
    commit(c);
  };
  t.add('spanning-tree portfast default', HW, flag('portfastDefault', true));
  t.add('no spanning-tree portfast default', HW, flag('portfastDefault', false));
  t.add('spanning-tree portfast bpduguard default', HW, flag('bpduguardDefault', true));
  t.add('no spanning-tree portfast bpduguard default', HW, flag('bpduguardDefault', false));
  t.add('spanning-tree portfast bpdufilter default', HW, flag('bpdufilterDefault', true));
  t.add('no spanning-tree portfast bpdufilter default', HW, flag('bpdufilterDefault', false));
  t.add('spanning-tree loopguard default', HW, flag('loopguardDefault', true));
  t.add('no spanning-tree loopguard default', HW, flag('loopguardDefault', false));
  t.add('spanning-tree extend system-id', HW, () => {});

  // errdisable recovery
  const errCfg = (c: Ctx) => (c.dev.running.errdisable ??= { causes: [], interval: 300 });
  const CAUSES = ['all', 'bpduguard', 'psecure-violation', 'channel-misconfig', 'link-flap', 'loopback', 'udld'];
  t.add('errdisable recovery cause <word:why>', HW, (c, a) => {
    const cause = CAUSES.find((x) => x.startsWith(String(a.why).toLowerCase()));
    if (!cause) return caret(c, a['@why'] as number);
    if (!errCfg(c).causes.includes(cause)) errCfg(c).causes.push(cause);
  });
  t.add('no errdisable recovery cause <word:why>', HW, (c, a) => {
    const cause = CAUSES.find((x) => x.startsWith(String(a.why).toLowerCase()));
    errCfg(c).causes = errCfg(c).causes.filter((x) => x !== cause);
  });
  t.add('errdisable recovery interval <number:secs:30-86400>', HW, (c, a) => void (errCfg(c).interval = a.secs as number));

  // VTP
  const vtp = (c: Ctx) => (c.dev.running.vtp ??= { ...DEFAULT_VTP });
  for (const mode of ['server', 'client', 'transparent', 'off'] as const) {
    t.add(`vtp mode ${mode}`, HW, (c) => {
      const v = vtp(c);
      if (v.mode === mode) return void c.out.push(`Device mode already VTP ${mode[0].toUpperCase() + mode.slice(1)} for VLANS.`);
      v.mode = mode;
      if (mode === 'transparent' || mode === 'off') c.dev.vtpRevision = 0;
      c.out.push(`Setting device to VTP ${mode[0].toUpperCase() + mode.slice(1)} mode for VLANS.`);
      commit(c);
    });
  }
  t.add('vtp domain <word:dname>', HW, (c, a) => {
    const v = vtp(c);
    const name = String(a.dname).slice(0, 32);
    if (v.domain === name) return void c.out.push(`Domain name already set to ${name}.`);
    c.out.push(`Changing VTP domain name from ${v.domain ?? 'NULL'} to ${name}`);
    v.domain = name;
    commit(c);
  });
  t.add('vtp password <word:pw>', HW, (c, a) => {
    vtp(c).password = String(a.pw);
    c.out.push(`Setting device VTP password to ${a.pw}`);
    commit(c);
  });
  t.add('no vtp password', HW, (c) => {
    vtp(c).password = null;
    c.out.push('Clearing device VTP password.');
    commit(c);
  });
  t.add('vtp version <number:ver:1-3>', HW, (c, a) => void ((vtp(c).version = a.ver as 1 | 2 | 3), commit(c)));
}

// ---------------------------------------------------------------- interface commands

export function addSwitchInterface(t: Tree): void {
  const ports = (c: Ctx) => c.s.ifContext.map((n) => c.dev.running.interfaces[n]).filter(Boolean);
  const each = (fn: (c: Ctx, ifc: InterfaceConfig, a: Args) => string | void) => (c: Ctx, a: Args) => {
    for (const ifc of ports(c)) {
      const err = fn(c, ifc, a);
      if (err) {
        c.out.push(err);
        break;
      }
    }
    commit(c);
  };
  const st = (ifc: InterfaceConfig) => (ifc.stp ??= {});
  t.add(
    'spanning-tree portfast',
    HW,
    each((c, ifc) => {
      st(ifc).portfast = 'enable';
      c.out.push(
        '%Warning: portfast should only be enabled on ports connected to a single',
        ' host. Connecting hubs, concentrators, switches, bridges, etc... to this',
        ' interface  when portfast is enabled, can cause temporary bridging loops.',
        ' Use with CAUTION',
        '',
      );
      if (ifc.switchport?.mode !== 'access') c.out.push(`%Portfast has been configured on ${ifc.name} but will only`, ' have effect when the interface is in a non-trunking mode.');
    }),
  );
  t.add('spanning-tree portfast trunk', HW, each((_c, ifc) => void (st(ifc).portfast = 'trunk')));
  t.add('spanning-tree portfast disable', HW, each((_c, ifc) => void (st(ifc).portfast = 'disable')));
  t.add('no spanning-tree portfast', HW, each((_c, ifc) => void delete st(ifc).portfast));
  for (const opt of ['bpduguard', 'bpdufilter'] as const) {
    t.add(`spanning-tree ${opt} enable`, HW, each((_c, ifc) => void (st(ifc)[opt] = 'enable')));
    t.add(`spanning-tree ${opt} disable`, HW, each((_c, ifc) => void (st(ifc)[opt] = 'disable')));
    t.add(`no spanning-tree ${opt}`, HW, each((_c, ifc) => void delete st(ifc)[opt]));
  }
  for (const g of ['root', 'loop', 'none'] as const) t.add(`spanning-tree guard ${g}`, HW, each((_c, ifc) => void (st(ifc).guard = g)));
  t.add('no spanning-tree guard', HW, each((_c, ifc) => void delete st(ifc).guard));
  t.add('spanning-tree cost <number:n:1-200000000>', HW, each((_c, ifc, a) => void (st(ifc).cost = a.n as number)));
  t.add('no spanning-tree cost', HW, each((_c, ifc) => void delete st(ifc).cost));
  t.add(
    'spanning-tree port-priority <number:n:0-240>',
    HW,
    each((_c, ifc, a) => {
      if ((a.n as number) % 16) return '% Port Priority in increments of 16 is required\n% Allowed values are:\n  0   16  32  48  64  80  96  112 128 144 160 176 192 208 224 240';
      st(ifc).priority = a.n as number;
    }),
  );

  // port security
  const ps = (ifc: InterfaceConfig): PortSecurity => (ifc.portSecurity ??= { enabled: false, max: 1, violation: 'shutdown', sticky: false, macs: [], stickyMacs: [] });
  const needAccess = (fn: (c: Ctx, ifc: InterfaceConfig, a: Args) => string | void) => (c: Ctx, ifc: InterfaceConfig, a: Args) => {
    if (!ifc.switchport) return '% Invalid input detected: not a switchport';
    if (ifc.switchport.mode !== 'access' && ifc.switchport.mode !== 'trunk') return `Command rejected: ${ifc.name} is a dynamic port.`;
    return fn(c, ifc, a);
  };
  t.add('switchport port-security', HW, each(needAccess((_c, ifc) => void (ps(ifc).enabled = true))));
  t.add('no switchport port-security', HW, each((c, ifc) => {
    if (ifc.portSecurity) ifc.portSecurity.enabled = false;
    delete c.dev.psecLearned?.[ifc.name];
  }));
  t.add('switchport port-security maximum <number:n:1-132>', HW, each(needAccess((_c, ifc, a) => void (ps(ifc).max = a.n as number))));
  t.add('no switchport port-security maximum', HW, each((_c, ifc) => void (ps(ifc).max = 1)));
  for (const v of ['protect', 'restrict', 'shutdown'] as const) {
    t.add(`switchport port-security violation ${v}`, HW, each(needAccess((_c, ifc) => void (ps(ifc).violation = v))));
  }
  t.add('no switchport port-security violation', HW, each((_c, ifc) => void (ps(ifc).violation = 'shutdown')));
  t.add('switchport port-security mac-address sticky', HW, each(needAccess((c, ifc) => {
    ps(ifc).sticky = true;
    // Already-learned addresses become sticky.
    const learned = c.dev.psecLearned?.[ifc.name] ?? [];
    ps(ifc).stickyMacs.push(...learned.filter((m) => !ps(ifc).stickyMacs.includes(m)));
    if (c.dev.psecLearned) c.dev.psecLearned[ifc.name] = [];
  })));
  t.add('no switchport port-security mac-address sticky', HW, each((_c, ifc) => {
    if (!ifc.portSecurity) return;
    ifc.portSecurity.sticky = false;
    ifc.portSecurity.stickyMacs = [];
  }));
  const macOk = (m: string) => /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i.test(m);
  t.add('switchport port-security mac-address <word:mac>', HW, (c, a) => {
    if (!macOk(String(a.mac))) return caret(c, a['@mac'] as number);
    each(needAccess((_c, ifc) => void ps(ifc).macs.push(String(a.mac).toLowerCase())))(c, a);
  });
  t.add('switchport port-security mac-address sticky <word:mac>', HW, (c, a) => {
    if (!macOk(String(a.mac))) return caret(c, a['@mac'] as number);
    each(needAccess((_c, ifc) => void ps(ifc).stickyMacs.push(String(a.mac).toLowerCase())))(c, a);
  });
  t.add('no switchport port-security mac-address sticky <word:mac>', HW, each((_c, ifc, a) => {
    if (ifc.portSecurity) ifc.portSecurity.stickyMacs = ifc.portSecurity.stickyMacs.filter((m) => m !== String(a.mac).toLowerCase());
  }));
  t.add('no switchport port-security mac-address <word:mac>', HW, each((_c, ifc, a) => {
    if (ifc.portSecurity) ifc.portSecurity.macs = ifc.portSecurity.macs.filter((m) => m !== String(a.mac).toLowerCase());
  }));

  // EtherChannel
  const modes: ChannelMode[] = ['on', 'active', 'passive', 'desirable', 'auto'];
  for (const m of modes) {
    t.add(`channel-group <number:group:1-48> mode ${m}`, HW, (c, a) => {
      const id = a.group as number;
      const po = `Port-channel${id}`;
      const proto = (x: ChannelMode) => (x === 'active' || x === 'passive' ? 'lacp' : x === 'on' ? 'on' : 'pagp');
      // All members of a group must use the same protocol.
      const clash = Object.values(c.dev.running.interfaces).find((i) => i.channelGroup?.id === id && proto(i.channelGroup.mode) !== proto(m) && !c.s.ifContext.includes(i.name));
      if (clash) return void c.out.push(`Command rejected (${po}, ${shortIfName(c.s.ifContext[0])}): Invalid etherchnl mode`);
      for (const name of c.s.ifContext) {
        const ifc = c.dev.running.interfaces[name];
        if (!ifc || !c.dev.hardware[name]) continue;
        if (!c.dev.running.interfaces[po]) {
          c.out.push(`Creating a port-channel interface ${po} `);
          c.dev.running.interfaces[po] = { ...structuredClone(ifc), name: po, description: null, channelGroup: undefined, shutdown: false, stp: ifc.stp ? { ...ifc.stp } : undefined };
          delete c.dev.running.interfaces[po].channelGroup;
        }
        ifc.channelGroup = { id, mode: m };
      }
      commit(c);
    });
  }
  t.add('no channel-group', HW, each((_c, ifc) => void delete ifc.channelGroup));
}

/** After a command on a port-channel, copy its switchport settings to the members (as IOS does). */
export function propagatePortChannel(c: Ctx): void {
  for (const name of c.s.ifContext) {
    if (!name.startsWith('Port-channel')) continue;
    const po = c.dev.running.interfaces[name];
    if (!po) continue;
    const id = Number(name.slice(12));
    for (const m of Object.values(c.dev.running.interfaces)) {
      if (m.channelGroup?.id !== id) continue;
      m.switchport = po.switchport ? structuredClone(po.switchport) : null;
      m.shutdown = po.shutdown;
    }
  }
  commit(c);
}

// ---------------------------------------------------------------- show / clear

function stpBlock(c: Ctx, vlan: number): string[] {
  const b = c.net.stp.vlans.get(vlan)?.get(c.dev.id);
  const name = `VLAN${String(vlan).padStart(4, '0')}`;
  if (!b) return stpOf(c.dev).disabled.includes(vlan) ? [`Spanning tree instance(s) for vlan ${vlan} does not exist.`] : [];
  const isRoot = b.rootDevice === c.dev.id;
  const proto = stpOf(c.dev).mode === 'rapid-pvst' ? 'rstp' : 'ieee';
  const out = [name, `  Spanning tree enabled protocol ${proto}`, `  Root ID    Priority    ${b.rootPriority}`, `             Address     ${b.rootMac}`];
  if (isRoot) out.push('             This bridge is the root');
  else {
    const rp = b.ports.find((p) => p.name === b.rootPort);
    out.push(`             Cost        ${b.rootCost}`, `             Port        ${rp?.num ?? 0} (${b.rootPort ?? 'unknown'})`);
  }
  out.push(
    '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec',
    '',
    `  Bridge ID  Priority    ${b.priority}  (priority ${bridgePriority(c.dev, vlan)} sys-id-ext ${vlan})`,
    `             Address     ${b.mac}`,
    '             Hello Time   2 sec  Max Age 20 sec  Forward Delay 15 sec',
    '             Aging Time  300 sec',
    '',
    'Interface           Role Sts Cost      Prio.Nbr Type',
    '------------------- ---- --- --------- -------- --------------------------------',
  );
  for (const p of b.ports) {
    const sts = p.inconsistent ? 'BKN*' : p.state;
    const type = `P2p${p.edge ? ' Edge' : ''}${p.inconsistent ? ` *${p.inconsistent}` : ''}`;
    out.push(`${shortIfName(p.name).padEnd(20)}${p.role} ${sts.padEnd(4)}${String(p.cost).padEnd(10)}${`${p.prio}.${p.num}`.padEnd(9)}${type} `);
  }
  out.push('');
  return out;
}

const vlanIds = (c: Ctx) => [...(c.net.stp.vlans.keys() ?? [])].filter((v) => c.net.stp.vlans.get(v)?.has(c.dev.id)).sort((a, b) => a - b);

export function addSwitchShows(t: Tree, privileged: boolean): void {
  t.add('show spanning-tree', HW, (c) => {
    for (const v of vlanIds(c)) c.out.push(...stpBlock(c, v));
  });
  t.add('show spanning-tree vlan <word:list>', HW, (c, a) => {
    const list = vlans(c, a);
    if (list) for (const v of list) c.out.push(...stpBlock(c, v));
  });
  t.add('show spanning-tree summary', HW, (c) => {
    const s = stpOf(c.dev);
    const ids = vlanIds(c);
    const roots = ids.filter((v) => c.net.stp.vlans.get(v)!.get(c.dev.id)!.rootDevice === c.dev.id);
    const yes = (b: boolean) => (b ? 'enabled' : 'disabled');
    c.out.push(
      `Switch is in ${s.mode} mode`,
      `Root bridge for: ${roots.length ? roots.map((v) => `VLAN${String(v).padStart(4, '0')}`).join(', ') : 'none'}`,
      'Extended system ID           is enabled',
      `Portfast Default             is ${yes(s.portfastDefault)}`,
      `PortFast BPDU Guard Default  is ${yes(s.bpduguardDefault)}`,
      `Portfast BPDU Filter Default is ${yes(s.bpdufilterDefault)}`,
      `Loopguard Default            is ${yes(s.loopguardDefault)}`,
      'EtherChannel misconfig guard is enabled',
      'UplinkFast                   is disabled',
      'BackboneFast                 is disabled',
      'Configured Pathcost method used is short',
      '',
      'Name                   Blocking Listening Learning Forwarding STP Active',
      '---------------------- -------- --------- -------- ---------- ----------',
    );
    let tb = 0;
    let tf = 0;
    for (const v of ids) {
      const b = c.net.stp.vlans.get(v)!.get(c.dev.id)!;
      const blk = b.ports.filter((p) => p.state === 'BLK').length;
      const fwd = b.ports.length - blk;
      tb += blk;
      tf += fwd;
      c.out.push(`${`VLAN${String(v).padStart(4, '0')}`.padEnd(23)}${String(blk).padStart(8)}${'0'.padStart(10)}${'0'.padStart(9)}${String(fwd).padStart(11)}${String(blk + fwd).padStart(11)}`);
    }
    c.out.push('---------------------- -------- --------- -------- ---------- ----------', `${`${ids.length} vlans`.padEnd(23)}${String(tb).padStart(8)}${'0'.padStart(10)}${'0'.padStart(9)}${String(tf).padStart(11)}${String(tb + tf).padStart(11)}`);
  });
  t.add('show spanning-tree inconsistentports', HW, (c) => {
    c.out.push('', 'Name                 Interface                Inconsistency', '-------------------- ------------------------ ------------------');
    let n = 0;
    for (const v of vlanIds(c)) {
      for (const p of c.net.stp.vlans.get(v)!.get(c.dev.id)!.ports) {
        if (!p.inconsistent) continue;
        n++;
        c.out.push(`${`VLAN${String(v).padStart(4, '0')}`.padEnd(21)}${p.name.padEnd(25)}${p.inconsistent === 'ROOT_Inc' ? 'Root Inconsistent' : 'Loop Inconsistent'}`);
      }
    }
    c.out.push('', `Number of inconsistent ports (segments) in the system : ${n}`, '');
  });
  t.add('show etherchannel summary', HW, (c) => {
    const mine = [...c.net.bundles.values()].filter((b) => b.device === c.dev.id);
    c.out.push(
      'Flags:  D - down        P - bundled in port-channel',
      '        I - stand-alone s - suspended',
      '        H - Hot-standby (LACP only)',
      '        R - Layer3      S - Layer2',
      '        U - in use      f - failed to allocate aggregator',
      '',
      '        M - not in use, minimum links not met',
      '        u - unsuitable for bundling',
      '        w - waiting to be aggregated',
      '        d - default port',
      '',
      '',
      `Number of channel-groups in use: ${mine.length}`,
      `Number of aggregators:           ${mine.length}`,
      '',
      'Group  Port-channel  Protocol    Ports',
      '------+-------------+-----------+-----------------------------------------------',
    );
    for (const b of mine.sort((x, y) => x.po.localeCompare(y.po))) {
      const po = c.dev.running.interfaces[b.po];
      const flags = `${po?.switchport ? 'S' : 'R'}${b.bundled.length ? 'U' : 'D'}`;
      const proto = b.mode === 'active' || b.mode === 'passive' ? 'LACP' : b.mode === 'on' ? '-' : 'PAgP';
      const members = [
        ...b.bundled.map((m) => [m, 'P']),
        ...b.suspended.map((m) => [m, 's']),
        ...b.standalone.map((m) => [m, 'I']),
        ...b.down.map((m) => [m, 'D']),
      ]
        .sort((x, y) => x[0].localeCompare(y[0], undefined, { numeric: true }))
        .map(([m, f]) => `${shortIfName(m)}(${f})`.padEnd(12))
        .join('');
      c.out.push(`${b.po.slice(12).padEnd(7)}${`Po${b.po.slice(12)}(${flags})`.padEnd(16)}${proto.padEnd(10)}${members}`);
    }
  });
  const neighbors = (proto: 'LACP' | 'PAgP') => (c: Ctx) => {
    for (const b of [...c.net.bundles.values()].filter((x) => x.device === c.dev.id)) {
      const isProto = proto === 'LACP' ? b.mode === 'active' || b.mode === 'passive' : b.mode === 'desirable' || b.mode === 'auto';
      if (!isProto) continue;
      c.out.push(`Channel group ${b.po.slice(12)} neighbors`, '', 'Port      Flags   Priority  Dev ID          Age    key    Key    Number  State');
      for (const m of [...b.bundled, ...b.standalone]) {
        const p = c.net.peerOf(c.dev.id, m);
        if (!p) continue;
        const pd = c.net.device(p.device);
        c.out.push(`${shortIfName(m).padEnd(10)}${(b.mode === 'active' ? 'SA' : 'SP').padEnd(8)}${'32768'.padEnd(10)}${pd.baseMac.padEnd(16)}${'3s'.padEnd(7)}${'0x0'.padEnd(7)}${('0x' + b.po.slice(12)).padEnd(7)}${('0x' + (Object.keys(pd.hardware).indexOf(p.iface) + 1).toString(16)).padEnd(8)}0x3D`);
      }
    }
  };
  t.add('show lacp neighbor', HW, neighbors('LACP'));
  t.add('show pagp neighbor', HW, neighbors('PAgP'));
  t.add('show port-security', HW, (c) => {
    c.out.push('Secure Port  MaxSecureAddr  CurrentAddr  SecurityViolation  Security Action', '                (Count)       (Count)          (Count)', '---------------------------------------------------------------------------');
    for (const ifc of Object.values(c.dev.running.interfaces)) {
      const ps = ifc.portSecurity;
      if (!ps?.enabled) continue;
      const cur = ps.macs.length + ps.stickyMacs.length + (c.dev.psecLearned?.[ifc.name]?.length ?? 0);
      const v = c.dev.psecViolations?.[ifc.name]?.count ?? 0;
      c.out.push(`${shortIfName(ifc.name).padStart(11)}${String(ps.max).padStart(15)}${String(cur).padStart(13)}${String(v).padStart(19)}${(ps.violation[0].toUpperCase() + ps.violation.slice(1)).padStart(17)}`);
    }
    c.out.push('---------------------------------------------------------------------------', 'Total Addresses in System (excluding one mac per port)     : 0', 'Max Addresses limit in System (excluding one mac per port) : 4096');
  });
  t.add('show port-security interface <iface:if>', HW, (c, a) => {
    const ifc = c.dev.running.interfaces[a.if as string];
    if (!ifc) return caret(c, a['@if'] as number);
    const ps = ifc.portSecurity;
    const err = c.dev.errDisabled?.[ifc.name];
    const status = !ps?.enabled ? 'Secure-down' : err ? 'Secure-shutdown' : c.net.isUp(c.dev.id, ifc.name) ? 'Secure-up' : 'Secure-down';
    const learned = c.dev.psecLearned?.[ifc.name] ?? [];
    const last = c.dev.psecViolations?.[ifc.name]?.lastMac ?? ps?.stickyMacs.at(-1) ?? learned.at(-1) ?? '0000.0000.0000';
    c.out.push(
      `Port Security              : ${ps?.enabled ? 'Enabled' : 'Disabled'}`,
      `Port Status                : ${status}`,
      `Violation Mode             : ${ps ? ps.violation[0].toUpperCase() + ps.violation.slice(1) : 'Shutdown'}`,
      'Aging Time                 : 0 mins',
      'Aging Type                 : Absolute',
      'SecureStatic Address Aging : Disabled',
      `Maximum MAC Addresses      : ${ps?.max ?? 1}`,
      `Total MAC Addresses        : ${(ps?.macs.length ?? 0) + (ps?.stickyMacs.length ?? 0) + learned.length}`,
      `Configured MAC Addresses   : ${ps?.macs.length ?? 0}`,
      `Sticky MAC Addresses       : ${ps?.stickyMacs.length ?? 0}`,
      `Last Source Address:Vlan   : ${last}:${ifc.switchport?.accessVlan ?? 1}`,
      `Security Violation Count   : ${c.dev.psecViolations?.[ifc.name]?.count ?? 0}`,
    );
  });
  t.add('show port-security address', HW, (c) => {
    c.out.push(
      '               Secure Mac Address Table',
      '-----------------------------------------------------------------------------',
      'Vlan    Mac Address       Type                          Ports   Remaining Age',
      '                                                                   (mins)    ',
      '----    -----------       ----                          -----   -------------',
    );
    for (const ifc of Object.values(c.dev.running.interfaces)) {
      const ps = ifc.portSecurity;
      if (!ps?.enabled) continue;
      const vlan = String(ifc.switchport?.accessVlan ?? 1).padStart(4);
      const row = (mac: string, type: string) => c.out.push(`${vlan}    ${mac.padEnd(18)}${type.padEnd(30)}${shortIfName(ifc.name).padEnd(13)}-`);
      for (const m of ps.macs) row(m, 'SecureConfigured');
      for (const m of ps.stickyMacs) row(m, 'SecureSticky');
      for (const m of c.dev.psecLearned?.[ifc.name] ?? []) row(m, 'SecureDynamic');
    }
    c.out.push('-----------------------------------------------------------------------------', 'Total Addresses in System (excluding one mac per port)     : 0', 'Max Addresses limit in System (excluding one mac per port) : 4096');
  });
  t.add('show errdisable recovery', HW, (c) => {
    const cfg = c.dev.running.errdisable ?? { causes: [], interval: 300 };
    c.out.push('ErrDisable Reason            Timer Status', '-----------------            --------------');
    for (const r of ['arp-inspection', 'bpduguard', 'channel-misconfig', 'dhcp-rate-limit', 'link-flap', 'loopback', 'psecure-violation', 'udld']) {
      c.out.push(`${r.padEnd(29)}${cfg.causes.includes('all') || cfg.causes.includes(r) ? 'Enabled' : 'Disabled'}`);
    }
    c.out.push('', `Timer interval: ${cfg.interval} seconds`, '', 'Interfaces that will be enabled at the next timeout:', '', 'Interface       Errdisable reason       Time left(sec)', '---------       -----------------       --------------');
    for (const [iface, e] of Object.entries(c.dev.errDisabled ?? {})) {
      if (!(cfg.causes.includes('all') || cfg.causes.includes(e.cause))) continue;
      c.out.push(`${shortIfName(iface).padEnd(16)}${e.cause.padEnd(24)}${Math.max(0, Math.round(cfg.interval - (c.net.time - e.at) / 1000))}`);
    }
  });
  t.add('show vtp status', HW, (c) => {
    const v = vtpOf(c.dev);
    c.out.push(
      'VTP Version capable             : 1 to 3',
      `VTP version running             : ${v.version}`,
      `VTP Domain Name                 : ${v.domain ?? ''}`,
      'VTP Pruning Mode                : Disabled',
      'VTP Traps Generation            : Disabled',
      `Device ID                       : ${c.dev.baseMac}`,
      `Configuration last modified by ${formatIp(0)} at 0-0-00 00:00:00`,
      '',
      'Feature VLAN:',
      '--------------',
      `VTP Operating Mode                : ${v.mode[0].toUpperCase() + v.mode.slice(1)}`,
      'Maximum VLANs supported locally   : 1005',
      `Number of existing VLANs          : ${Object.keys(c.dev.vlans).length}`,
      `Configuration Revision            : ${c.dev.vtpRevision ?? 0}`,
      'MD5 digest                        : 0x57 0xCD 0x40 0x65 0x63 0x59 0x47 0xBD ',
      '                                    0x56 0x9D 0x4A 0x3E 0xA5 0x69 0x35 0xBC ',
    );
  });
  t.add('show vtp password', HW, (c) => {
    const p = vtpOf(c.dev).password;
    c.out.push(p ? `VTP Password: ${p}` : 'The VTP password is not configured.');
  });
  if (privileged) {
    t.add('clear port-security sticky', HW, (c) => {
      for (const ifc of Object.values(c.dev.running.interfaces)) if (ifc.portSecurity) ifc.portSecurity.stickyMacs = [];
      commit(c);
    });
    t.add('clear port-security sticky interface <iface:if>', HW, (c, a) => {
      const ifc = c.dev.running.interfaces[a.if as string];
      if (!ifc) return caret(c, a['@if'] as number);
      if (ifc.portSecurity) ifc.portSecurity.stickyMacs = [];
      commit(c);
    });
    t.add('clear port-security all', HW, (c) => {
      for (const ifc of Object.values(c.dev.running.interfaces)) if (ifc.portSecurity) ifc.portSecurity.stickyMacs = [];
      c.dev.psecLearned = {};
      commit(c);
    });
  }
  void formatVlanList;
}

/** Config lines: spanning tree, errdisable and VTP (and, in transparent mode, the VLANs themselves). */
export function switchGlobalLines(d: import('../types').Device): string[] {
  const out: string[] = [];
  const v = d.running.vtp;
  if (v) {
    if (v.domain) out.push(`vtp domain ${v.domain}`);
    if (v.mode !== 'server') out.push(`vtp mode ${v.mode}`);
    if (v.version !== 1) out.push(`vtp version ${v.version}`);
  }
  const s = d.running.stp;
  out.push(`spanning-tree mode ${s?.mode ?? 'pvst'}`);
  if (s?.portfastDefault) out.push('spanning-tree portfast default');
  if (s?.bpduguardDefault) out.push('spanning-tree portfast bpduguard default');
  if (s?.bpdufilterDefault) out.push('spanning-tree portfast bpdufilter default');
  if (s?.loopguardDefault) out.push('spanning-tree loopguard default');
  out.push('spanning-tree extend system-id');
  if (s?.disabled.length) out.push(`no spanning-tree vlan ${formatVlanList(s.disabled)}`);
  for (const e of s?.priorities ?? []) out.push(`spanning-tree vlan ${formatVlanList(e.vlans)} priority ${e.priority}`);
  const e = d.running.errdisable;
  if (e) {
    for (const c of e.causes) out.push(`errdisable recovery cause ${c}`);
    if (e.interval !== 300) out.push(`errdisable recovery interval ${e.interval}`);
  }
  out.push('!');
  if (v && (v.mode === 'transparent' || v.mode === 'off')) {
    for (const [id, vl] of Object.entries(d.vlans).map(([k, x]) => [Number(k), x] as const).sort((a, b) => a[0] - b[0])) {
      if (id === 1 || id >= 1002) continue;
      out.push(`vlan ${id}`, ` name ${vl.name}`, '!');
    }
  }
  return out;
}

/** Interface lines for switching features. */
export function switchInterfaceLines(ifc: InterfaceConfig): string[] {
  const out: string[] = [];
  const ps = ifc.portSecurity;
  if (ps && (ps.enabled || ps.max !== 1 || ps.violation !== 'shutdown' || ps.sticky || ps.macs.length)) {
    if (ps.enabled) out.push(' switchport port-security');
    if (ps.max !== 1) out.push(` switchport port-security maximum ${ps.max}`);
    if (ps.violation !== 'shutdown') out.push(` switchport port-security violation ${ps.violation}`);
    for (const m of ps.macs) out.push(` switchport port-security mac-address ${m}`);
    if (ps.sticky) out.push(' switchport port-security mac-address sticky');
    for (const m of ps.stickyMacs) out.push(` switchport port-security mac-address sticky ${m}`);
  }
  if (ifc.channelGroup) out.push(` channel-group ${ifc.channelGroup.id} mode ${ifc.channelGroup.mode}`);
  const s = ifc.stp;
  if (s) {
    if (s.portfast === 'enable') out.push(' spanning-tree portfast');
    if (s.portfast === 'trunk') out.push(' spanning-tree portfast trunk');
    if (s.portfast === 'disable') out.push(' spanning-tree portfast disable');
    if (s.bpdufilter) out.push(` spanning-tree bpdufilter ${s.bpdufilter}`);
    if (s.bpduguard) out.push(` spanning-tree bpduguard ${s.bpduguard}`);
    if (s.guard) out.push(` spanning-tree guard ${s.guard}`);
    if (s.cost !== undefined) out.push(` spanning-tree cost ${s.cost}`);
    if (s.priority !== undefined) out.push(` spanning-tree port-priority ${s.priority}`);
  }
  return out;
}
