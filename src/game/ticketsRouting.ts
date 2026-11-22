// Tickets from dynamic routing at HQ (OSPF between CR-CORE1 and CR-RTR1), plus the BGP change request.

import { controlPlane } from '../sim/control';
import { parseIp } from '../sim/ip';
import type { Network } from '../sim/network';
import { routingTable } from '../sim/routing';
import { FS01, INTERNET, NIC, freePeople, person, reaches, variant, type TicketTemplate } from './ticketKit';

const ROUTING = ['ospf-passive-default', 'ospf-hello-mismatch', 'ospf-area-mismatch', 'ospf-default-missing', 'bgp-migration'];

const ospf = (net: Network, id: string) => net.device(id).running.routing?.ospf.find((p) => p.pid === 1);

/** The predecessor's OSPF setup is in place and the adjacency is FULL. */
function ospfHealthy(net: Network): boolean {
  const core = ospf(net, 'core1');
  const rtr = ospf(net, 'rtr1');
  if (!core || !rtr || !rtr.defaultOriginate) return false;
  if (!core.passive.passiveDefault || core.passive.exceptions.join() !== 'FastEthernet0/24') return false;
  if (net.device('rtr1').running.interfaces['GigabitEthernet0/0'].ospf?.hello !== undefined) return false;
  if (rtr.networks.some((n) => n.area !== 0)) return false;
  return controlPlane(net).ospf.instances.some((i) => i.dev.id === 'core1' && i.neighbors.some((n) => n.state === 'FULL'));
}

function otherStaff(net: Network, people: { pcId: string }[], pcId: string): string {
  const floor = net.peerOf(pcId, NIC)?.device;
  const others = people.filter((p) => p.pcId !== pcId);
  return (others.find((p) => net.peerOf(p.pcId, NIC)?.device !== floor) ?? others[0]).pcId;
}

const outage = (
  id: string,
  difficulty: TicketTemplate['difficulty'],
  spec: { subject: string; descriptions: string[]; inject: (net: Network) => void; fix: (net: Network) => void; explain: string; hint: string },
): TicketTemplate => ({
  id,
  difficulty,
  canStart: (ctx) => !ROUTING.some((t) => ctx.activeTemplates.has(t)) && !ctx.activeTemplates.has('default-route') && ospfHealthy(ctx.net) && freePeople(ctx).length > 1,
  plan: (ctx) => {
    const pcId = ctx.rng.pick(freePeople(ctx)).pcId;
    return { pcId, other: otherStaff(ctx.net, freePeople(ctx), pcId), variant: ctx.rng.int(0, spec.descriptions.length - 1) };
  },
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const other = String(params.other);
    return {
      templateId: id,
      params,
      kind: 'incident',
      difficulty,
      truePriority: 1,
      subject: spec.subject,
      description: variant(spec.descriptions, params),
      reporter: p,
      pcs: [p.pcId, other],
      inject: () => {
        spec.inject(net);
        net.log(id === 'ospf-passive-default' ? 'core1' : 'rtr1', '%SYS-5-CONFIG_I: Configured from console by dlindqvist on vty0 (10.10.99.21)');
        net.commit();
      },
      check: () => reaches(net, p.pcId, INTERNET, FS01) && reaches(net, other, INTERNET),
      fix: () => {
        spec.fix(net);
        net.commit();
      },
      explain: spec.explain,
      hint: spec.hint,
    };
  },
});

const passiveDefault = outage('ospf-passive-default', 'moderate', {
  subject: 'Internet is down for the whole office',
  descriptions: [
    `No websites, no email from outside. The S: drive is fine. Everyone around me has the same problem.`,
    `The internet just died for the whole floor. Teams dropped mid-call with a client.`,
  ],
  inject: (net) => {
    const p = ospf(net, 'core1')!;
    p.passive = { passiveDefault: true, exceptions: [] };
  },
  fix: (net) => void (ospf(net, 'core1')!.passive = { passiveDefault: true, exceptions: ['FastEthernet0/24'] }),
  explain:
    "Someone re-entered `passive-interface default` under `router ospf 1` on CR-CORE1, which wiped the `no passive-interface FastEthernet0/24` exception. With the uplink passive, the OSPF adjacency to CR-RTR1 dropped: the core lost its default route, and the router lost its routes back to the office VLANs. `no passive-interface Fa0/24` brought the neighbor back to FULL.",
  hint: 'Inside works, outside doesn\'t. How does the core learn where the internet is? Check its neighbors.',
});

const helloMismatch = outage('ospf-hello-mismatch', 'hard', {
  subject: 'Internet down after this morning\'s maintenance',
  descriptions: [
    `Since about 7am nothing outside our network works. Email is down, websites won't load. Shared drive is okay.`,
    `We can't reach any websites or our cloud portal. IT did some maintenance last night, maybe related?`,
  ],
  inject: (net) => void ((net.device('rtr1').running.interfaces['GigabitEthernet0/0'].ospf ??= {}).hello = 5),
  fix: (net) => void delete net.device('rtr1').running.interfaces['GigabitEthernet0/0'].ospf?.hello,
  explain:
    "CR-RTR1's Gi0/0 had `ip ospf hello-interval 5` (someone tuning for faster failover), which also makes its dead interval 20. OSPF neighbors must agree on hello and dead timers, so the adjacency to CR-CORE1 never came back, and IOS doesn't log that without debugging. `show ip ospf interface` on both ends shows Hello 5/Dead 20 against Hello 10/Dead 40. Removing the hello-interval (or matching it on both ends) fixed it.",
  hint: 'The routers can ping each other but OSPF won\'t form. Compare the OSPF interface settings on both ends of that link.',
});

const areaMismatch = outage('ospf-area-mismatch', 'hard', {
  subject: 'Whole office lost internet',
  descriptions: [
    `Every website times out and Outlook is disconnected. The S: drive works. This is everyone, not just me.`,
    `Internet's down for everyone, we can't even get to the client portal. Please hurry.`,
  ],
  inject: (net) => {
    const p = ospf(net, 'rtr1')!;
    p.networks = p.networks.map((n) => ({ ...n, area: 1 }));
  },
  fix: (net) => {
    const p = ospf(net, 'rtr1')!;
    p.networks = p.networks.map((n) => ({ ...n, area: 0 }));
  },
  explain:
    "On CR-RTR1, the OSPF network statement for the core link had been changed to `area 1`, while CR-CORE1 has that link in area 0. Neighbors must be in the same area, and both routers were logging `%OSPF-4-ERRRCV: Received invalid packet: mismatched area ID`. Putting the statement back in area 0 restored the adjacency.",
  hint: 'Read the logs from both routers. OSPF is complaining about something specific.',
});

const defaultMissing = outage('ospf-default-missing', 'moderate', {
  subject: 'No internet anywhere, everything internal works',
  descriptions: [
    `Our internet is down. I can still open the S: drive and LedgerWorks, just nothing outside.`,
    `Nobody can reach any websites. Internal stuff is fine.`,
  ],
  inject: (net) => void (ospf(net, 'rtr1')!.defaultOriginate = null),
  fix: (net) => void (ospf(net, 'rtr1')!.defaultOriginate = { always: false }),
  explain:
    "`default-information originate` was removed from `router ospf 1` on CR-RTR1. The router still had its static default to the ISP, but it stopped advertising a default into OSPF, so CR-CORE1 had no gateway of last resort and dropped everything headed outside. Putting the command back restored the O*E2 default on the core.",
  hint: 'Look at the core\'s routing table. Where would it send a packet for 8.8.8.8?',
});

const bgpMigration: TicketTemplate = {
  id: 'bgp-migration',
  difficulty: 'expert',
  canStart: (ctx) =>
    !ROUTING.some((t) => ctx.activeTemplates.has(t)) &&
    !ctx.usedTemplates.has('bgp-migration') &&
    !ctx.net.device('rtr1').running.routing?.bgp &&
    ospfHealthy(ctx.net) &&
    freePeople(ctx).length > 0,
  plan: (ctx) => ({ pcId: (ctx.office.people.find((p) => p.department === 'Partners' && !ctx.busyPcs.has(p.pcId)) ?? ctx.rng.pick(freePeople(ctx))).pcId }),
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    return {
      templateId: 'bgp-migration',
      params,
      kind: 'request',
      difficulty: 'expert',
      truePriority: 4,
      subject: 'Change request: move the Brightline circuit to BGP',
      description:
        "Brightline is retiring static routing for business circuits. They're ready to peer with us now: they're AS 64500, we're AS 65010, peering on our WAN link. Please set it up so our default route comes from them, take the static default out, and make sure nothing breaks for the office. Marty has approved this as a standard change.",
      reporter: p,
      pcs: [],
      inject: () => {},
      check: () => {
        const r = net.device('rtr1');
        const bgp = controlPlane(net).bgp.instances.find((i) => i.dev.id === 'rtr1');
        const up = bgp?.sessions.some((s) => s.peer === parseIp('203.0.113.1') && s.state === 'Established');
        const noStatic = !r.running.staticRoutes.some((s) => s.prefix === 0);
        const bgpDefault = routingTable(net, r).some((x) => x.prefix === 0 && x.code === 'B');
        const staff = env.office.people.filter((x) => net.peerOf(x.pcId, NIC)).slice(0, 2);
        return !!up && noStatic && bgpDefault && staff.every((s) => reaches(net, s.pcId, INTERNET));
      },
      fix: () => {
        const r = net.device('rtr1').running;
        r.staticRoutes = r.staticRoutes.filter((s) => s.prefix !== 0);
        r.routing!.bgp = { asn: 65010, routerId: null, neighbors: { '203.0.113.1': { remoteAs: 64500, description: 'Brightline Fiber' } }, networks: [], redistribute: [] };
        net.commit();
      },
      explain:
        "`router bgp 65010` with `neighbor 203.0.113.1 remote-as 64500` on CR-RTR1 brought the session up, and Brightline sent a default route (B* 0.0.0.0/0 [20/0]). The static default had to go: with AD 1 it would always beat eBGP's 20. `default-information originate` under OSPF keeps working, because the router still has a default in its table, now from BGP.",
      hint: 'Two things decide which default the router uses: whether each one is in the table, and administrative distance.',
    };
  },
};

export const ROUTING_TICKETS: TicketTemplate[] = [passiveDefault, helloMismatch, areaMismatch, defaultMissing, bgpMigration];
