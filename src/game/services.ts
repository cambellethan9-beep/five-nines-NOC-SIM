// Business services and who can use them right now. Feeds the uptime drain and availability %.

import type { Office } from '../content/office';
import { parseIp } from '../sim/ip';
import type { Network } from '../sim/network';
import { canReach } from '../sim/routing';

export interface Service {
  id: string;
  name: string;
  /** Address a user's PC must reach; printing depends on the user's floor. */
  target: (net: Network, pcId: string) => string;
}

function floorPrinter(net: Network, pcId: string): string {
  const peer = net.peerOf(pcId, 'FastEthernet0');
  return peer?.device === 'acc2' ? '10.10.30.22' : '10.10.30.21';
}

export const SERVICES: Service[] = [
  { id: 'internet', name: 'Internet', target: () => '8.8.8.8' },
  { id: 'files', name: 'File server (S:)', target: () => '10.10.20.11' },
  { id: 'ledger', name: 'LedgerWorks', target: () => '10.10.20.12' },
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
      if (!canReach(net, pc.id, parseIp(s.target(net, pc.id))!)) {
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
