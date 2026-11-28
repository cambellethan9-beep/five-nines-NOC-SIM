// Topics: every fault building block and every ticket template is tagged with what it's about. They drive your
// skill radar (how well you handle each topic), employees' topic skills, and learning by doing.

import { SLA } from './scoring';
import type { Ticket } from './queue';
import type { TicketDraft } from './ticketKit';

export type Topic = 'physical' | 'switching' | 'stp' | 'dhcpdns' | 'routing' | 'acl' | 'nat' | 'security' | 'endpoints' | 'ops';

export const TOPICS: { id: Topic; name: string; short: string }[] = [
  { id: 'physical', name: 'Cabling and hardware', short: 'Physical' },
  { id: 'switching', name: 'Switch ports, VLANs and trunks', short: 'VLANs' },
  { id: 'stp', name: 'STP and EtherChannel', short: 'STP' },
  { id: 'dhcpdns', name: 'DHCP and DNS', short: 'DHCP/DNS' },
  { id: 'routing', name: 'Routing', short: 'Routing' },
  { id: 'acl', name: 'ACLs', short: 'ACLs' },
  { id: 'nat', name: 'NAT', short: 'NAT' },
  { id: 'security', name: 'Switch security and hardening', short: 'Security' },
  { id: 'endpoints', name: 'PCs and printers', short: 'Endpoints' },
  { id: 'ops', name: 'Operations: backups, upgrades, monitoring', short: 'Ops' },
];

export const topicName = (t: Topic) => TOPICS.find((x) => x.id === t)?.name ?? t;

export const FAULT_TOPICS: Record<string, Topic[]> = {
  'port-shut': ['switching'],
  'access-vlan': ['switching'],
  'access-port-trunk': ['switching'],
  'cable-out': ['physical'],
  'cable-bad': ['physical'],
  'nic-disabled': ['endpoints'],
  'nic-driver': ['endpoints'],
  'static-gateway': ['endpoints'],
  'stale-dns': ['dhcpdns'],
  'print-driver': ['endpoints'],
  apipa: ['dhcpdns'],
  'trunk-pruned': ['switching'],
  'uplink-shut': ['switching'],
  'vlan-deleted': ['switching'],
  'svi-shut': ['routing'],
  'svi-ip': ['routing'],
  'helper-gone': ['dhcpdns'],
  'acl-block': ['acl'],
  'server-port': ['switching'],
  'server-vlan': ['switching'],
  'printer-port': ['switching'],
  'printer-cable': ['physical'],
  'default-route': ['routing'],
  'default-next-hop': ['routing'],
  'infra-cable': ['physical'],
  'nic-dead': ['physical'],
  'port-dead': ['physical', 'switching'],
  'helper-typo': ['dhcpdns'],
  'nat-inside-off': ['nat'],
  'nat-acl-narrow': ['nat', 'acl'],
  'ospf-passive': ['routing'],
  'ospf-network': ['routing'],
  'psec-violation': ['security'],
};

export const TEMPLATE_TOPICS: Record<string, Topic[]> = {
  'port-shutdown': ['switching'],
  'wrong-vlan': ['switching'],
  'cable-unplugged': ['physical'],
  'nic-disabled': ['endpoints'],
  'bad-cable': ['physical'],
  'driver-outdated': ['endpoints'],
  'driver-missing': ['endpoints'],
  'printer-port': ['switching'],
  'printer-vlan': ['switching'],
  'trunk-pruned': ['switching'],
  'default-route': ['routing'],
  'fs-speed': ['physical'],
  'moved-desk': ['switching'],
  'partner-vlan': ['switching'],
  'apipa-blip': ['dhcpdns'],
  'wrong-gateway': ['endpoints'],
  'stale-dns': ['dhcpdns'],
  'helper-missing': ['dhcpdns'],
  'acl-web-filter': ['acl'],
  'acl-printer-wildcard': ['acl'],
  'acl-vty-lockout': ['acl', 'security'],
  'nat-acl-narrowed': ['nat', 'acl'],
  'nat-no-overload': ['nat'],
  'nat-inside-missing': ['nat'],
  'guest-no-gateway': ['dhcpdns'],
  'guest-pool-full': ['dhcpdns'],
  'guest-dns-internal': ['dhcpdns'],
  'ospf-passive-default': ['routing'],
  'ospf-hello-mismatch': ['routing'],
  'ospf-area-mismatch': ['routing'],
  'ospf-default-missing': ['routing'],
  'bgp-migration': ['routing'],
  'stp-loop': ['stp'],
  'bpduguard-desk-switch': ['stp', 'security'],
  'psecure-loaner': ['security'],
  'etherchannel-uplinks': ['stp'],
  'vtp-wipe': ['switching'],
  'duplex-mismatch': ['physical'],
  'rogue-device': ['security'],
  'config-backups': ['ops'],
  'hardening-audit': ['security'],
  'shut-unused-ports': ['security'],
  'device-passwords': ['security'],
  'snooping-rollout': ['security', 'dhcpdns'],
  'dai-rollout': ['security'],
  'nsos-upgrade': ['ops'],
  'guest-hours': ['acl'],
  'rogue-dhcp': ['security', 'dhcpdns'],
  'dai-printers': ['security'],
  'option82-outage': ['security', 'dhcpdns'],
  'printer-cable': ['physical'],
  'printer-driver': ['endpoints'],
  'patched-wrong': ['physical', 'switching'],
};

/** What a ticket is about. Generated tickets take the topics of every fault in them. */
export function ticketTopics(draft: Pick<TicketDraft, 'templateId' | 'params'>): Topic[] {
  if (draft.templateId === 'generated') {
    const atoms: { id: string }[] = JSON.parse(String(draft.params.atoms ?? '[]'));
    const set = new Set<Topic>();
    for (const a of atoms) (FAULT_TOPICS[a.id] ?? []).forEach((t) => set.add(t));
    return [...set];
  }
  return TEMPLATE_TOPICS[draft.templateId] ?? [];
}

/** How many tickets in a topic count toward its score. */
export const RADAR_WINDOW = 20;

/**
 * How well you handled one ticket, 0-100: fixed it yourself quickly scores high, late lower; false resolves, Owen's
 * hint and handing it up all cost. Tickets employees or delegates fixed don't count (they say nothing about you).
 */
export function ticketPerformance(t: Ticket, hinted: boolean): number | null {
  if (t.resolvedAt === null) return null;
  if (t.employee || t.escalation?.delegated) return null;
  if (t.draft.templateId === 'port-shutdown' && t.shift === 1 && t.id === 'INC-1001') return null; // the tutorial
  let v: number;
  if (t.resolvedBy || t.status === 'senior-resolved') v = 20;
  else if (t.proactive) v = 100;
  else {
    const frac = (t.resolvedAt - t.openedAt) / SLA[t.truePriority].resolveMs;
    v = frac <= 1 ? 100 - 40 * frac : Math.max(30, 60 - 30 * (frac - 1));
  }
  v -= 30 * t.falseResolves;
  if (hinted) v -= 15;
  return Math.max(0, Math.min(100, Math.round(v)));
}

export interface TopicScore {
  topic: Topic;
  /** null until you've closed a ticket in this topic. */
  score: number | null;
  tickets: number;
}

/** Your skill radar: per topic, the average of your last 20 tickets in it. */
export function playerSkills(tickets: Ticket[], hinted: string[]): TopicScore[] {
  const sorted = [...tickets].filter((t) => t.resolvedAt !== null).sort((a, b) => b.resolvedAt! - a.resolvedAt!);
  return TOPICS.map(({ id }) => {
    const vals: number[] = [];
    for (const t of sorted) {
      if (vals.length >= RADAR_WINDOW) break;
      if (!ticketTopics(t.draft).includes(id)) continue;
      const v = ticketPerformance(t, hinted.includes(t.id));
      if (v !== null) vals.push(v);
    }
    return { topic: id, score: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null, tickets: vals.length };
  });
}
