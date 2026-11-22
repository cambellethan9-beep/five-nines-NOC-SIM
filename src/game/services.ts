// Business services and who can use them right now. Feeds the uptime drain and availability %.

import type { Office } from '../content/office';
import { parseIp } from '../sim/ip';
import type { Network } from '../sim/network';
import { canReach, type Flow } from '../sim/routing';
import { resolve } from '../sim/dns';

/**
 * What users' apps actually send to each target, so ACLs see real traffic: SMB to the file server, HTTPS to
 * LedgerWorks and the internet, DNS to the domain controller, raw printing (9100) to printers.
 */
export function serviceFlow(target: string): Flow {
  if (target === '10.10.20.11') return { proto: 'tcp', port: 445 };
  if (target === '10.10.20.12') return { proto: 'tcp', port: 443 };
  if (target === '10.10.20.10') return { proto: 'udp', port: 53 };
  if (target.startsWith('10.10.30.')) return { proto: 'tcp', port: 9100 };
  if (!target.startsWith('10.')) return { proto: 'tcp', port: 443 };
  return { proto: 'icmp' };
}

/** Can this PC use the service at `target`? `count` adds the traffic to ACL hit counters. */
export function reachService(net: Network, pcId: string, target: string, count = false): boolean {
  return canReach(net, pcId, parseIp(target)!, serviceFlow(target), count);
}

export interface Service {
  id: string;
  name: string;
  /** Address a user's PC must reach; printing depends on the user's floor. */
  target: (net: Network, pcId: string) => string;
  /** Apps that connect by name go through the PC's DNS resolver (and its cache). */
  byName?: string;
}

function floorPrinter(net: Network, pcId: string): string {
  const peer = net.peerOf(pcId, 'FastEthernet0');
  return peer?.device === 'acc2' ? '10.10.30.22' : '10.10.30.21';
}

export const SERVICES: Service[] = [
  { id: 'internet', name: 'Internet', target: () => '8.8.8.8' },
  { id: 'files', name: 'File server (S:)', target: () => '10.10.20.11' },
  { id: 'ledger', name: 'LedgerWorks', target: () => '10.10.20.12', byName: 'ledgerworks' },
  { id: 'dns', name: 'Domain / DNS', target: () => '10.10.20.10' },
  { id: 'print', name: 'Printing', target: floorPrinter },
];

export interface ServiceHealth {
  /** Users currently at their desks (awake PCs). */
  usersPresent: number;
  /** Per service: how many present users can't use it. */
  down: Record<string, number>;
  /** Total (user, service) pairs that are broken. */
  brokenPairs: number;
  /** Distinct users with at least one broken service. */
  affectedUsers: number;
  /** Broken service ids per present user's PC id. */
  perUser: Record<string, string[]>;
}

export function serviceHealth(net: Network, office: Office): ServiceHealth {
  const down: Record<string, number> = Object.fromEntries(SERVICES.map((s) => [s.id, 0]));
  let present = 0;
  let pairs = 0;
  let affected = 0;
  const perUser: Record<string, string[]> = {};
  for (const person of office.people) {
    const pc = net.device(person.pcId);
    if (!pc.powered) continue; // asleep: nobody is there to notice
    present++;
    let broken = false;
    for (const s of SERVICES) {
      let ok: boolean;
      if (s.byName && pc.hostNet) {
        const r = resolve(net, pc.id, s.byName);
        ok = r.ok && canReach(net, pc.id, r.ip, { proto: 'tcp', port: 443 }, true);
      } else {
        ok = reachService(net, pc.id, s.target(net, pc.id), true);
      }
      if (!ok) {
        down[s.id]++;
        pairs++;
        broken = true;
        (perUser[pc.id] ??= []).push(s.id);
      }
    }
    if (broken) affected++;
  }
  return { usersPresent: present, down, brokenPairs: pairs, affectedUsers: affected, perUser };
}
