// Tickets from switching: a loop through a filtered spare uplink, a desk switch tripping BPDU guard, a loaner PC
// tripping port security, the uplink EtherChannel request, and the VTP revision wipe.

import type { Network } from '../sim/network';
import type { Device } from '../sim/types';
import { reachService } from './services';
import { FS01, INTERNET, NIC, freePeople, person, portLabel, reaches, variant, withAwake, type TicketTemplate } from './ticketKit';

const SWITCHING = ['stp-loop', 'bpduguard-desk-switch', 'psecure-loaner', 'etherchannel-uplinks', 'vtp-wipe'];
const free = (ctx: Parameters<TicketTemplate['canStart']>[0]) => !SWITCHING.some((t) => ctx.activeTemplates.has(t));

function onFloor(ctx: Parameters<TicketTemplate['plan']>[0], sw: 'acc1' | 'acc2') {
  return freePeople(ctx).filter((p) => ctx.net.peerOf(p.pcId, NIC)?.device === sw);
}

function errDisable(net: Network, sw: Device, iface: string, cause: string): void {
  (sw.errDisabled ??= {})[iface] = { cause, at: net.time };
  net.commit();
}

const stpLoop: TicketTemplate = {
  id: 'stp-loop',
  difficulty: 'expert',
  canStart: (ctx) => free(ctx) && ctx.net.device('core1').running.interfaces['GigabitEthernet0/3']?.shutdown === true && onFloor(ctx, 'acc1').length > 0 && onFloor(ctx, 'acc2').length > 0,
  plan: (ctx) => ({ pcId: ctx.rng.pick(onFloor(ctx, 'acc1')).pcId, other: ctx.rng.pick(onFloor(ctx, 'acc2')).pcId, variant: ctx.rng.int(0, 1) }),
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const other = String(params.other);
    const coreG3 = () => net.device('core1').running.interfaces['GigabitEthernet0/3'];
    const accG2 = () => net.device('acc1').running.interfaces['GigabitEthernet0/2'];
    return {
      templateId: 'stp-loop',
      params,
      kind: 'incident',
      difficulty: 'expert',
      truePriority: 1,
      subject: 'EVERYTHING is down',
      description: variant(
        [
          `Nothing works. No internet, no S: drive, no printing, nothing. Phones on the desk are flashing too. The whole office is affected.`,
          `The entire network is down! I can't open anything and neither can anyone around me. It started a few minutes ago.`,
        ],
        params,
      ),
      reporter: p,
      pcs: [p.pcId, other],
      inject: () => {
        // "Finishing the EtherChannel" half-way: the spare uplink came up, with BPDU filter "to quiet the logs".
        coreG3().shutdown = false;
        (coreG3().stp ??= {}).bpdufilter = 'enable';
        (accG2().stp ??= {}).bpdufilter = 'enable';
        net.log('core1', '%SYS-5-CONFIG_I: Configured from console by dlindqvist on vty0 (10.10.99.21)');
        net.commit();
      },
      check: () => reaches(net, p.pcId, FS01, INTERNET) && reaches(net, other, FS01, INTERNET),
      fix: () => {
        coreG3().shutdown = true;
        delete coreG3().stp?.bpdufilter;
        delete accG2().stp?.bpdufilter;
        net.commit();
      },
      explain:
        "Someone brought up the spare uplink between CR-CORE1 Gi0/3 and CR-ACC1 Gi0/2 and put `spanning-tree bpdufilter enable` on both ends. With BPDUs filtered, spanning tree never saw the second path, so both links forwarded: a switching loop and a broadcast storm across every VLAN. The giveaway is the `%SW_MATM-4-MACFLAP_NOTIF` messages, MACs flapping between Gi0/1 and Gi0/3. Shutting Gi0/3 (or removing the filter so STP can block it) stopped the storm.",
      hint: 'When everything fails at once, look for what changed and what the switches are complaining about. Which MACs are moving between which ports?',
    };
  },
};

const deskSwitch: TicketTemplate = {
  id: 'bpduguard-desk-switch',
  difficulty: 'moderate',
  canStart: (ctx) => free(ctx) && onFloor(ctx, 'acc1').length > 0,
  plan: (ctx) => ({ pcId: ctx.rng.pick(onFloor(ctx, 'acc1')).pcId, variant: ctx.rng.int(0, 1) }),
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const port = () => net.peerOf(p.pcId, NIC)!;
    return {
      templateId: 'bpduguard-desk-switch',
      params,
      kind: 'incident',
      difficulty: 'moderate',
      truePriority: 3,
      subject: 'Network stopped after I plugged in a small switch',
      description: variant(
        [
          `I needed more ports for my laptop dock so I brought in a little switch from home. As soon as I plugged it in, everything stopped. I already took it out and plugged my PC straight back in but still nothing.`,
          `Plugged a switch under my desk so I could connect two things. Network died instantly. Removed it, still dead.`,
        ],
        params,
      ),
      reporter: p,
      pcs: [p.pcId],
      inject: () => {
        const sw = net.device(port().device);
        net.log(sw.id, `%SPANTREE-2-BLOCK_BPDUGUARD: Received BPDU on port ${port().iface} with BPDU Guard enabled. Disabling port.`);
        net.log(sw.id, `%PM-4-ERR_DISABLE: bpduguard error detected on ${port().iface.replace('FastEthernet', 'Fa')}, putting ${port().iface.replace('FastEthernet', 'Fa')} in err-disable state`);
        errDisable(net, sw, port().iface, 'bpduguard');
      },
      check: () => reaches(net, p.pcId, FS01, INTERNET),
      fix: () => {
        const sw = net.device(port().device);
        if (sw.errDisabled) delete sw.errDisabled[port().iface];
        net.commit();
      },
      explain: `The home switch sent BPDUs into ${portLabel(net, p.pcId)}, which has PortFast and BPDU guard. BPDU guard did its job and err-disabled the port. Once the switch was gone, \`shutdown\` then \`no shutdown\` on the port brought it back.`,
      hint: 'Look at what the access switch thinks of that port. `show interfaces status` will tell you more than "notconnect".',
    };
  },
};

const loaner: TicketTemplate = {
  id: 'psecure-loaner',
  difficulty: 'moderate',
  canStart: (ctx) => free(ctx) && onFloor(ctx, 'acc2').some((p) => ctx.net.device('acc2').running.interfaces[ctx.net.peerOf(p.pcId, NIC)!.iface]?.portSecurity?.enabled),
  plan: (ctx) => {
    const pick = ctx.rng.pick(onFloor(ctx, 'acc2').filter((p) => ctx.net.device('acc2').running.interfaces[ctx.net.peerOf(p.pcId, NIC)!.iface]?.portSecurity?.enabled));
    return { pcId: pick.pcId, mac: `00e0.4c${ctx.rng.int(16, 255).toString(16).padStart(2, '0')}.${ctx.rng.int(4096, 65535).toString(16)}`, variant: ctx.rng.int(0, 1) };
  },
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const pc = () => net.device(p.pcId);
    return {
      templateId: 'psecure-loaner',
      params,
      kind: 'incident',
      difficulty: 'moderate',
      truePriority: 3,
      subject: 'Loaner PC has no network',
      description: variant(
        [
          `My PC is at the repair shop so IT gave me a loaner. It powers on fine but has no network at all. Same cable, same desk.`,
          `They swapped my computer for a temporary one this morning and it can't connect to anything.`,
        ],
        params,
      ),
      reporter: p,
      pcs: [p.pcId],
      inject: () => {
        pc().hardware[NIC].mac = String(params.mac);
        net.commit();
      },
      check: () => withAwake(net, [p.pcId], () => reachService(net, p.pcId, FS01) && reachService(net, p.pcId, INTERNET)),
      fix: () => {
        const peer = net.peerOf(p.pcId, NIC)!;
        const sw = net.device(peer.device);
        const ifc = sw.running.interfaces[peer.iface];
        if (ifc.portSecurity) ifc.portSecurity.stickyMacs = [String(params.mac)];
        if (sw.errDisabled) delete sw.errDisabled[peer.iface];
        net.commit();
      },
      explain: `The 2nd-floor ports run sticky port security with a maximum of one MAC. ${portLabel(net, p.pcId)} still had the old PC's MAC stuck to it, so the loaner's different MAC was a violation and the port went err-disabled (\`%PORT_SECURITY-2-PSECURE_VIOLATION\`). Clearing the sticky entry (\`clear port-security sticky interface ...\`, or \`no switchport port-security mac-address sticky <old MAC>\`) and bouncing the port let it learn the loaner.`,
      hint: 'Same cable, same port, different computer. What on the switch cares which computer is plugged in?',
    };
  },
};

const etherchannel: TicketTemplate = {
  id: 'etherchannel-uplinks',
  difficulty: 'hard',
  canStart: (ctx) => free(ctx) && !ctx.usedTemplates.has('etherchannel-uplinks') && ctx.net.device('core1').running.interfaces['GigabitEthernet0/3']?.shutdown === true && freePeople(ctx).length > 0,
  plan: (ctx) => ({ pcId: (ctx.office.people.find((p) => p.department === 'Admin' && !ctx.busyPcs.has(p.pcId)) ?? ctx.rng.pick(freePeople(ctx))).pcId }),
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const staffOn1 = env.office.people.filter((x) => net.peerOf(x.pcId, NIC)?.device === 'acc1').slice(0, 2);
    const bundled = (id: string) =>
      [...net.bundles.values()].some((b) => b.device === id && b.bundled.length === 2 && (b.mode === 'active' || b.mode === 'passive') && net.isUp(id, b.po));
    return {
      templateId: 'etherchannel-uplinks',
      params,
      kind: 'request',
      difficulty: 'hard',
      truePriority: 4,
      subject: 'Change request: finish the 1st floor uplink redundancy',
      description:
        "Last month's outage on the 1st floor was a single uplink. The second cable from CR-CORE1 Gi0/3 to CR-ACC1 Gi0/2 is already run. Please bundle both uplinks into one LACP EtherChannel so the floor survives a link failure. Marty approved it for tonight's change window.",
      reporter: p,
      pcs: [],
      inject: () => {},
      check: () => bundled('core1') && bundled('acc1') && staffOn1.every((s) => reaches(net, s.pcId, FS01, INTERNET)),
      fix: () => {
        for (const [id, members] of [
          ['core1', ['GigabitEthernet0/1', 'GigabitEthernet0/3']],
          ['acc1', ['GigabitEthernet0/1', 'GigabitEthernet0/2']],
        ] as const) {
          const d = net.device(id);
          const first = d.running.interfaces[members[0]];
          d.running.interfaces['Port-channel1'] = { ...structuredClone(first), name: 'Port-channel1', description: id === 'core1' ? 'Uplink to CR-ACC1' : 'Uplink to CR-CORE1' };
          delete d.running.interfaces['Port-channel1'].channelGroup;
          for (const m of members) {
            const ifc = d.running.interfaces[m];
            ifc.switchport = structuredClone(first.switchport);
            ifc.shutdown = false;
            ifc.channelGroup = { id: 1, mode: 'active' };
            delete ifc.stp?.bpdufilter;
          }
        }
        net.commit();
      },
      explain:
        "`interface range` the two uplinks on each switch, `channel-group 1 mode active` (LACP; at least one side has to be active), with identical trunk settings on both members. `show etherchannel summary` shows Po1(SU) with both ports (P), and spanning tree treats Po1 as a single link, so nothing gets blocked and losing one cable doesn't drop the floor.",
      hint: 'Both members need the same settings, and LACP needs someone to start the conversation.',
    };
  },
};

const vtpWipe: TicketTemplate = {
  id: 'vtp-wipe',
  difficulty: 'expert',
  canStart: (ctx) =>
    free(ctx) &&
    ['core1', 'acc1', 'acc2'].every((id) => ctx.net.device(id).running.vtp?.mode === 'transparent' && ctx.net.device(id).vlans[30] && ctx.net.device(id).vlans[40]) &&
    onFloor(ctx, 'acc1').length > 0 &&
    onFloor(ctx, 'acc2').length > 0,
  plan: (ctx) => ({ pcId: ctx.rng.pick(onFloor(ctx, 'acc1')).pcId, other: ctx.rng.pick(onFloor(ctx, 'acc2')).pcId }),
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const other = String(params.other);
    const printerOf = (pc: string) => (net.peerOf(pc, NIC)?.device === 'acc2' ? '10.10.30.22' : '10.10.30.21');
    return {
      templateId: 'vtp-wipe',
      params,
      kind: 'incident',
      difficulty: 'expert',
      truePriority: 2,
      subject: 'Printing is down everywhere, and the conference room too',
      description:
        "Nobody can print on either floor, and the conference room PC has no network. I think IT was doing something with the switches this morning? The S: drive still works for me.",
      reporter: p,
      pcs: [p.pcId, other, 'conf1'],
      inject: () => {
        // "Standardizing VLAN management": VTP server/client, using CR-ACC2 (an old lab switch with a high revision
        // and a trimmed VLAN list) as a server.
        for (const id of ['core1', 'acc1']) net.device(id).running.vtp = { mode: id === 'core1' ? 'server' : 'client', domain: 'CEDAR', password: null, version: 1 };
        const acc2 = net.device('acc2');
        acc2.running.vtp = { mode: 'server', domain: 'CEDAR', password: null, version: 1 };
        delete acc2.vlans[30];
        delete acc2.vlans[40];
        acc2.vtpRevision = 37;
        net.log('acc2', '%SYS-5-CONFIG_I: Configured from console by dlindqvist on vty0 (10.10.99.21)');
        net.commit();
      },
      check: () =>
        [p.pcId, other].every((pc) => reaches(net, pc, printerOf(pc))) && withAwake(net, ['conf1'], () => reachService(net, 'conf1', INTERNET)),
      fix: () => {
        for (const id of ['core1', 'acc1', 'acc2']) {
          const d = net.device(id);
          d.running.vtp = { mode: 'transparent', domain: 'CEDAR', password: null, version: 1 };
          d.vtpRevision = 0;
          d.vlans[30] = { name: 'PRINTERS' };
          d.vlans[40] = { name: 'GUEST' };
        }
        net.commit();
      },
      explain:
        "Someone switched the office to VTP server/client and left CR-ACC2 as a server. CR-ACC2 had an old configuration revision (37) from its lab days and no VLANs 30 or 40, and VTP always believes the highest revision. Its VLAN database replaced everyone else's, so VLAN 30 (printers) and 40 (guest) vanished from every switch and their ports went inactive. Setting the switches back to `vtp mode transparent` and recreating `vlan 30 name PRINTERS` and `vlan 40 name GUEST` on each fixed it. (Recreating them on a server also works, as long as every switch ends up with them.)",
      hint: 'Ports are up but their VLANs seem to have disappeared. Check `show vlan brief` on each switch, then ask who decided which VLANs exist.',
    };
  },
};

export const SWITCHING_TICKETS: TicketTemplate[] = [stpLoop, deskSwitch, loaner, etherchannel, vtpWipe];
