// Tickets caused by access lists. The classic symptoms: ping works but the app doesn't, a wildcard written as
// a subnet mask, and a vty access-class that locks the NOC out of a switch.

import { canMakeChange } from './access';
import { evaluate, type Acl } from '../sim/acl';
import { parseIp } from '../sim/ip';
import type { Network } from '../sim/network';
import { canReach } from '../sim/routing';
import { FS01, INTERNET, NIC, freePeople, person, portLabel, reaches, variant, type TicketTemplate } from './ticketKit';

const LEDGER = '10.10.20.12';
const NOC_PC_IP = '10.10.99.50';

/** Floor printer for a PC (the same rule the Printing service uses). */
function printerFor(net: Network, pcId: string): string {
  return net.peerOf(pcId, NIC)?.device === 'acc2' ? '10.10.30.22' : '10.10.30.21';
}

/** Can the NOC PC SSH to this device (path, port 22, and the vty access-class)? */
export function nocCanManage(net: Network, deviceId: string, ip: string): boolean {
  if (!canReach(net, 'noc', parseIp(ip)!, { proto: 'tcp', port: 22 })) return false;
  const dev = net.device(deviceId);
  const name = dev.running.lines.vty.accessClass;
  const acl = name ? dev.running.acls?.[name] : undefined;
  if (!acl || !acl.entries.some((e) => e.remark === undefined)) return true;
  return evaluate(acl, { proto: 'tcp', src: parseIp(NOC_PC_IP)!, dst: parseIp(ip)!, dstPort: 22 }).permit;
}

/** A staff PC other than `pcId`, preferably on the other floor. */
function otherStaff(net: Network, people: { pcId: string }[], pcId: string): string {
  const floor = net.peerOf(pcId, NIC)?.device;
  const others = people.filter((p) => p.pcId !== pcId && net.peerOf(p.pcId, NIC));
  return (others.find((p) => net.peerOf(p.pcId, NIC)?.device !== floor) ?? others[0]).pcId;
}

const webFilter: TicketTemplate = {
  id: 'acl-web-filter',
  difficulty: 'hard',
  canStart: (ctx) => canMakeChange(ctx.net, 'dlindqvist', 'core1') && !ctx.activeTemplates.has('acl-web-filter') && !ctx.net.device('core1').running.interfaces['Vlan10'].accessGroup?.in && freePeople(ctx).length > 1,
  plan: (ctx) => {
    const pcId = ctx.rng.pick(freePeople(ctx)).pcId;
    return { pcId, other: otherStaff(ctx.net, freePeople(ctx), pcId), variant: ctx.rng.int(0, 1) };
  },
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const other = String(params.other);
    const core = () => net.device('core1');
    return {
      templateId: 'acl-web-filter',
      params,
      kind: 'incident',
      difficulty: 'hard',
      truePriority: 1,
      subject: 'LedgerWorks and websites down for everyone',
      description: variant(
        [
          `LedgerWorks won't load and neither will any website. Half the office is saying the same thing. Weirdly the S: drive still works.`,
          `Nobody on our floor can get into LedgerWorks, and Google just spins. Teams is down too. IT, please, we have a client deadline today.`,
        ],
        params,
      ),
      reporter: p,
      pcs: [p.pcId, other],
      inject: () => {
        const acl: Acl = {
          name: 'STAFF-WEB',
          type: 'extended',
          named: true,
          entries: [
            { seq: 5, remark: 'Block streaming per R. Dunmore. Web only - DL' },
            { seq: 10, action: 'permit', proto: 'udp', src: { addr: 0, wildcard: 0xffffffff }, dst: { addr: 0, wildcard: 0xffffffff }, dstPort: { op: 'eq', ports: [53] } },
            { seq: 20, action: 'permit', proto: 'tcp', src: { addr: 0, wildcard: 0xffffffff }, dst: { addr: parseIp(FS01)!, wildcard: 0 }, dstPort: { op: 'eq', ports: [445] } },
            { seq: 30, action: 'permit', proto: 'tcp', src: { addr: 0, wildcard: 0xffffffff }, dst: { addr: 0, wildcard: 0xffffffff }, dstPort: { op: 'eq', ports: [80] } },
            { seq: 40, action: 'permit', proto: 'icmp', src: { addr: 0, wildcard: 0xffffffff }, dst: { addr: 0, wildcard: 0xffffffff } },
          ],
        };
        (core().running.acls ??= {})['STAFF-WEB'] = acl;
        core().running.interfaces['Vlan10'].accessGroup = { ...core().running.interfaces['Vlan10'].accessGroup, in: 'STAFF-WEB' };
        net.log('core1', '%SYS-5-CONFIG_I: Configured from console by dlindqvist on vty0 (10.10.99.21)');
        net.commit();
      },
      check: () => reaches(net, p.pcId, LEDGER, INTERNET, FS01) && reaches(net, other, LEDGER, INTERNET),
      fix: () => {
        const ifc = core().running.interfaces['Vlan10'];
        if (ifc.accessGroup) delete ifc.accessGroup.in;
        delete core().running.acls?.['STAFF-WEB'];
        net.commit();
      },
      explain:
        'An extended ACL called STAFF-WEB was applied inbound on CR-CORE1 Vlan10. It permitted DNS, SMB to the file server, plain HTTP (port 80) and ICMP, and nothing else. So pings and the S: drive worked, but HTTPS (443) to LedgerWorks and every modern website hit the implicit deny at the end. Removing the access-group (or permitting tcp 443) fixed it. The `show access-lists` counters show which lines match, and the implicit deny never shows a count.',
      hint: 'Ping works and the S: drive works, but anything over HTTPS fails. What on the path cares about which port you use?',
    };
  },
};

const printerWildcard: TicketTemplate = {
  id: 'acl-printer-wildcard',
  difficulty: 'moderate',
  canStart: (ctx) => canMakeChange(ctx.net, 'dlindqvist', 'core1') &&
    !ctx.activeTemplates.has('acl-printer-wildcard') &&
    !ctx.activeTemplates.has('printer-vlan') &&
    !ctx.net.device('core1').running.interfaces['Vlan30'].accessGroup?.out &&
    !ctx.net.device('core1').running.acls?.['30'] &&
    freePeople(ctx).length > 1,
  plan: (ctx) => {
    const pcId = ctx.rng.pick(freePeople(ctx)).pcId;
    return { pcId, other: otherStaff(ctx.net, freePeople(ctx), pcId), variant: ctx.rng.int(0, 1) };
  },
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const other = String(params.other);
    const core = () => net.device('core1');
    const prints = (pc: string) => reaches(net, pc, printerFor(net, pc));
    return {
      templateId: 'acl-printer-wildcard',
      params,
      kind: 'incident',
      difficulty: 'moderate',
      truePriority: 2,
      subject: 'Nobody can print',
      description: variant(
        [
          `Printing has been broken since this morning. The printer itself looks fine, it just never gets the job. My coworker upstairs says theirs is the same.`,
          `Every print job sits in the queue saying "Error - Printing". Both printers. We have tax returns to get out today.`,
        ],
        params,
      ),
      reporter: p,
      pcs: [p.pcId, other],
      inject: () => {
        // Someone meant "only staff may print" and typed the subnet mask where the wildcard goes.
        // IOS keeps it as written: permit 0.0.0.0 255.255.255.0, which matches almost nothing.
        (core().running.acls ??= {})['30'] = {
          name: '30',
          type: 'standard',
          named: false,
          entries: [{ seq: 10, action: 'permit', src: { addr: 0, wildcard: parseIp('255.255.255.0')! } }],
        };
        core().running.interfaces['Vlan30'].accessGroup = { ...core().running.interfaces['Vlan30'].accessGroup, out: '30' };
        net.log('core1', '%SYS-5-CONFIG_I: Configured from console by dlindqvist on vty0 (10.10.99.21)');
        net.commit();
      },
      check: () => prints(p.pcId) && prints(other),
      fix: () => {
        core().running.acls!['30'].entries = [{ seq: 10, action: 'permit', src: { addr: parseIp('10.10.10.0')!, wildcard: 255 } }];
        net.commit();
      },
      explain:
        "Access list 30 was applied outbound on CR-CORE1 Vlan30 to let only the staff VLAN reach the printers, but it was typed with a subnet mask instead of a wildcard: `access-list 30 permit 10.10.10.0 255.255.255.0`. IOS clears the address bits the wildcard ignores, so it became `permit 0.0.0.0 255.255.255.0`, which only matches addresses ending in .0. Everything else hit the implicit deny. The correct line is `access-list 30 permit 10.10.10.0 0.0.0.255`.",
      hint: 'Look at how CR-CORE1 stores the ACL on the printer VLAN, not how someone meant to write it. Wildcards are the inverse of masks.',
    };
  },
};

const vtyLockout: TicketTemplate = {
  id: 'acl-vty-lockout',
  difficulty: 'moderate',
  canStart: (ctx) =>
    !ctx.activeTemplates.has('acl-vty-lockout') &&
    !ctx.net.device('acc2').running.lines.vty.accessClass &&
    freePeople(ctx).some((p) => ctx.net.peerOf(p.pcId, NIC)?.device === 'acc2'),
  plan: (ctx) => ({ pcId: ctx.rng.pick(freePeople(ctx).filter((p) => ctx.net.peerOf(p.pcId, NIC)?.device === 'acc2')).pcId, variant: ctx.rng.int(0, 1) }),
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const acc2 = () => net.device('acc2');
    const port = () => {
      const peer = net.peerOf(p.pcId, NIC)!;
      return acc2().running.interfaces[peer.iface];
    };
    return {
      templateId: 'acl-vty-lockout',
      params,
      kind: 'incident',
      difficulty: 'moderate',
      truePriority: 3,
      subject: 'No network at my desk upstairs',
      description: variant(
        [`My PC upstairs has no network at all since this morning. Everyone else seems okay.`, `Network's dead at my desk on the 2nd floor. The cable is plugged in, I checked.`],
        params,
      ),
      reporter: p,
      pcs: [p.pcId],
      inject: () => {
        // A "hardening" change last night: vty access limited to... the staff subnet instead of management.
        (acc2().running.acls ??= {})['5'] = {
          name: '5',
          type: 'standard',
          named: false,
          entries: [{ seq: 10, action: 'permit', src: { addr: parseIp('10.10.10.0')!, wildcard: 255 } }],
        };
        acc2().running.lines.vty.accessClass = '5';
        port().shutdown = true;
        net.commit();
      },
      check: () => reaches(net, p.pcId, FS01, INTERNET),
      fix: () => {
        acc2().running.acls!['5'].entries = [{ seq: 10, action: 'permit', src: { addr: parseIp('10.10.99.0')!, wildcard: 255 } }];
        port().shutdown = false;
        net.commit();
      },
      explain: `${portLabel(net, p.pcId)} was shut down, an easy fix, except that the same overnight change added \`access-class 5 in\` to CR-ACC2's vty lines with access list 5 permitting 10.10.10.0/24 (the staff VLAN) instead of 10.10.99.0/24 (management). SSH from the NOC PC was refused, so it took a walk to the console. Fix the port, and fix ACL 5 so the NOC can manage the switch again.`,
      hint: 'If SSH says "Connection refused" but the switch answers pings, something on the switch is refusing you. You can always walk to the console.',
    };
  },
};

export const ACL_TEMPLATES: TicketTemplate[] = [webFilter, printerWildcard, vtyLockout];
