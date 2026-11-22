// The predecessor's documentation. Written once, at hand-off. It does not update itself:
// as the network changes, these documents slowly go stale (configuration drift).

import { COMPANY, ISP, NETWORK_DEVICES, PRINTERS, SERVERS, VLANS, type Office } from './office';

export type Block =
  | { h: string }
  | { p: string }
  | { code: string }
  | { ul: string[] }
  | { ol: string[] }
  | { note: string }
  | { table: { head: string[]; rows: string[][] } };

export interface Doc {
  id: string;
  title: string;
  kind: 'reference' | 'playbook';
  author: string;
  updated: string;
  blocks: Block[];
  /** Set once you edit it: sim time of your last edit, and the predecessor's version for "Revert". */
  editedAt?: number;
  original?: Block[];
}

export const PREDECESSOR = 'Mike Delaney';

export function predecessorDocs(office: Office): Doc[] {
  const net = office.net;
  const switchName = (id: string) => net.device(id).running.hostname;
  const mgmtOf = (id: string) => NETWORK_DEVICES.find((d) => d.id === id)!.mgmtIp;
  const portShort = (p: string) => p.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gi');

  const portRows = office.people.map((p) => {
    const pcId = p.pcId;
    const peer = net.peerOf(pcId, 'FastEthernet0')!;
    const ip = net.device(pcId).running.interfaces['FastEthernet0'].ip!;
    const ipText = `10.10.10.${ip.address & 255}`;
    return [p.desk, p.name, p.department, p.pc, ipText, switchName(peer.device), portShort(peer.iface), '10'];
  });

  return [
    {
      id: 'readme',
      title: 'README - start here',
      kind: 'reference',
      author: PREDECESSOR,
      updated: 'Oct 30',
      blocks: [
        { p: `If you're reading this, you're the new network person at ${COMPANY}. Welcome. I've moved on, but I tried to leave things in decent shape.` },
        { h: 'The short version' },
        {
          ul: [
            'One building, two floors, about 20 people. Everything runs through the server room.',
            'Five VLANs: STAFF (10), SERVERS (20), PRINTERS (30), GUEST (40, the conference room and visitors, internet only) and MGMT (99). Details are in Network overview.',
            'Every switch and the router run NetSmart gear. The command line is Cisco IOS syntax, so any Cisco guide on Google applies.',
            'The core switch (CR-CORE1) does the routing between VLANs. The router (CR-RTR1) only talks to the ISP. They share routes over OSPF (process 1, area 0); CR-RTR1 hands the core its default route.',
            'Every switch and the router send syslog to the NOC PC, get their time from CR-DC01 and answer SNMP (community `cedar-mon`), so the Logs and Monitor tabs see everything.',
          ],
        },
        { h: 'Getting into the gear' },
        {
          p: 'Don\'t walk to the closets unless you have to. From the NOC PC you can SSH into everything. My key is installed on all of it, so there\'s no password prompt:',
        },
        { code: 'ssh nocadmin@10.10.99.11' },
        { p: 'Management IPs for every device are in Network overview. The account is `nocadmin` with privilege 15, so you land straight in enable mode.' },
        { h: 'Habits that will save you' },
        {
          ul: [
            'Run `write memory` after every change. If a switch reboots, anything unsaved is gone.',
            'Use `show interfaces status` on the access switches to see every port at a glance.',
            'Keep notes. Half of this job is remembering what you changed and why.',
          ],
        },
        { note: 'The playbooks cover the stuff that comes up every week. They worked when I wrote them. If something has changed since, trust what the devices tell you over what these docs say.' },
        { p: `- ${PREDECESSOR.split(' ')[0]}` },
      ],
    },
    {
      id: 'overview',
      title: 'Network overview',
      kind: 'reference',
      author: PREDECESSOR,
      updated: 'Oct 30',
      blocks: [
        { h: 'VLANs and subnets' },
        {
          table: {
            head: ['VLAN', 'Name', 'Subnet', 'Gateway', 'Used for'],
            rows: VLANS.map((v) => [String(v.id), v.name, v.subnet, `${v.gateway} (CR-CORE1)`, v.purpose]),
          },
        },
        { h: 'Network devices' },
        {
          table: {
            head: ['Hostname', 'Model', 'Management IP', 'Location', 'Role'],
            rows: NETWORK_DEVICES.map((d) => [d.hostname, d.model, d.mgmtIp, d.location, d.role]),
          },
        },
        { h: 'Servers' },
        { table: { head: ['Hostname', 'IP', 'Role', 'Connected to'], rows: SERVERS.map((s, i) => [s.hostname, s.ip, s.role, `CR-CORE1 Fa0/${i + 1}`]) } },
        { h: 'Printers' },
        {
          table: {
            head: ['Hostname', 'IP', 'Location', 'Connected to'],
            rows: PRINTERS.map((p) => [p.hostname, p.ip, p.location, `${switchName(p.switchId)} ${portShort(p.port)}`]),
          },
        },
        { h: 'Uplinks' },
        {
          table: {
            head: ['From', 'To', 'Type'],
            rows: [
              ['CR-RTR1 Gi0/1', `${ISP.name} (203.0.113.1)`, 'WAN, 203.0.113.0/30'],
              ['CR-RTR1 Gi0/0', 'CR-CORE1 Fa0/24', 'Routed, 10.0.0.0/30'],
              ['CR-CORE1 Gi0/1', 'CR-ACC1 Gi0/1', '802.1Q trunk'],
              ['CR-CORE1 Gi0/2', 'CR-ACC2 Gi0/1', '802.1Q trunk'],
              ['CR-CORE1 Fa0/10', 'NOC-PC (10.10.99.50)', 'Access, VLAN 99'],
              ['CR-CORE1 Fa0/23', 'CR-RTR1 Gi0/2', 'Spare cable, not configured (router port is shut)'],
            ],
          },
        },
        { h: 'Internet' },
        {
          ul: [
            `ISP: ${ISP.name}, circuit ID ${ISP.circuit}.`,
            `Our WAN address is ${ISP.wanIp}, their side is ${ISP.gateway}. The ISP router isn't ours, so don't try to log into it.`,
            `${ISP.name} support: ${ISP.support}. Have the circuit ID ready.`,
            `${ISP.name} can do BGP with us (they're AS ${ISP.asn}, we'd be AS ${ISP.ourAsn}) and send us a default route. I never got around to it; we use a static default.`,
            'Quick test from anywhere inside: `ping 8.8.8.8`.',
          ],
        },
      ],
    },
    {
      id: 'portmap',
      title: 'Desk and port map',
      kind: 'reference',
      author: PREDECESSOR,
      updated: 'Oct 30',
      blocks: [
        { p: 'Which desk plugs into which switch port. Desk numbers are floor-desk (1-07 is 1st floor, desk 7). All staff PCs are in VLAN 10 and get their address from DHCP on CR-DC01 (reserved per PC, so the IPs below don\'t change). CR-CORE1 relays DHCP for VLAN 10 with `ip helper-address 10.10.20.10`.' },
        { table: { head: ['Desk', 'Name', 'Dept', 'PC', 'IP', 'Switch', 'Port', 'VLAN'], rows: portRows } },
        { note: 'People move desks during busy season. If someone tells you they moved, this table is probably wrong for them.' },
      ],
    },
    {
      id: 'pb-no-network',
      title: 'Playbook: user has no network',
      kind: 'playbook',
      author: PREDECESSOR,
      updated: 'Sep 12',
      blocks: [
        { p: 'For "my internet is down", "I can\'t get to the S: drive" and similar, when it\'s one person and not the whole floor.' },
        {
          ol: [
            'Look up the person in Desk and port map. Note their switch and port.',
            `SSH to that floor's switch from the NOC PC: \`ssh nocadmin@${mgmtOf('acc1')}\` (1st floor) or \`ssh nocadmin@${mgmtOf('acc2')}\` (2nd floor).`,
            'Run `show interfaces status` and find their port.',
            'If the port says **disabled**, someone shut it down. Fix it with `configure terminal`, `interface fa0/X`, `no shutdown`, `end`.',
            'If it says **notconnect**, the PC is off, asleep or unplugged. Ask them to check the cable and wake the PC.',
            'If it says **connected**, check the VLAN column. Staff ports belong in VLAN 10.',
            'Run `write memory` so the fix survives a reboot.',
            'Ask the user to try again.',
          ],
        },
      ],
    },
    {
      id: 'pb-printer',
      title: 'Playbook: printer offline',
      kind: 'playbook',
      author: PREDECESSOR,
      updated: 'Aug 03',
      blocks: [
        {
          ol: [
            `From the NOC PC, \`ping\` the printer (${PRINTERS.map((p) => `${p.hostname} ${p.ip}`).join(', ')}).`,
            'If only one person can\'t print, it\'s their PC, not the printer. Start with the no-network playbook.',
            'If nobody can print, SSH to the printer\'s switch and check its port with `show interfaces status`. Printer ports are in VLAN 30.',
            'If the port is fine and ping still fails, someone needs to walk over and look at the printer.',
          ],
        },
      ],
    },
    {
      id: 'pb-internet',
      title: 'Playbook: internet down for everyone',
      kind: 'playbook',
      author: PREDECESSOR,
      updated: 'Jul 21',
      blocks: [
        {
          ol: [
            'From the NOC PC: `ping 10.10.99.1` (core), `ping 10.0.0.1` (router), `ping 8.8.8.8` (internet). The first one that fails tells you where to look.',
            `SSH to the router: \`ssh nocadmin@${mgmtOf('rtr1')}\`.`,
            'Run `show ip interface brief`. Gi0/1 is the WAN link and should be up/up.',
            `Run \`ping ${ISP.gateway}\`. If the WAN is up but this fails, call ${ISP.name} (${ISP.support}) with circuit ${ISP.circuit}.`,
            'If internal pings work but the router is unreachable, check CR-CORE1 Fa0/24 and CR-RTR1 Gi0/0.',
          ],
        },
      ],
    },
    {
      id: 'pb-changes',
      title: 'Playbook: making changes safely',
      kind: 'playbook',
      author: PREDECESSOR,
      updated: 'Jun 02',
      blocks: [
        {
          ul: [
            'Before changing anything, run `show running-config` and copy the relevant part into your notes.',
            'Change one thing at a time and test after each.',
            'Save with `write memory`. Unsaved changes disappear on reboot.',
            'Don\'t `reload` anything during business hours unless it\'s already down.',
            'Don\'t remove the `ip ssh pubkey-chain` entries, or the NOC PC loses passwordless access.',
          ],
        },
      ],
    },
  ];
}
