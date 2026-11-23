// Tickets on the guest VLAN, all rooted in CR-CORE1's IOS DHCP pool: no default-router, a pool filled by
// infinite leases, and guest DNS pointed at an internal server the guest ACL blocks.

import { canMakeChange } from './access';
import { dhcpRequest } from '../sim/dhcp';
import { flushDns, resolve } from '../sim/dns';
import { parseIp } from '../sim/ip';
import type { Network } from '../sim/network';
import { reachService } from './services';
import { INTERNET, freePeople, person, variant, withAwake, type TicketTemplate } from './ticketKit';

const CONF = 'conf1';
const GUEST_TEMPLATES = ['guest-no-gateway', 'guest-pool-full', 'guest-dns-internal'];
const core = (net: Network) => net.device('core1');
const pool = (net: Network) => core(net).running.dhcpPools?.GUEST;

/** The guest PC can browse the web by name. */
function confOnline(net: Network): boolean {
  return withAwake(net, [CONF], () => {
    const r = resolve(net, CONF, 'www.example.com');
    return r.ok && reachService(net, CONF, INTERNET);
  });
}

function poolIntact(net: Network): boolean {
  const p = pool(net);
  return (
    !!p &&
    p.network === parseIp('10.10.40.0') &&
    p.prefix === 24 &&
    p.defaultRouter[0] === parseIp('10.10.40.1') &&
    p.dnsServer[0] === parseIp('8.8.8.8') &&
    p.leaseMs === 8 * 3600_000 &&
    confOnline(net)
  );
}

function restorePool(net: Network): void {
  const p = pool(net)!;
  p.network = parseIp('10.10.40.0')!;
  p.prefix = 24;
  p.defaultRouter = [parseIp('10.10.40.1')!];
  p.dnsServer = [parseIp('8.8.8.8')!];
  p.leaseMs = 8 * 3600_000;
  core(net).dhcpBindings = {};
  net.commit();
  dhcpRequest(net, CONF);
  flushDns(net.device(CONF));
}

const guestTicket = (
  id: string,
  difficulty: TicketTemplate['difficulty'],
  spec: {
    truePriority: 1 | 2 | 3 | 4;
    subject: string;
    descriptions: string[];
    inject: (net: Network) => void;
    explain: string;
    hint: string;
  },
): TicketTemplate => ({
  id,
  difficulty,
  canStart: (ctx) => canMakeChange(ctx.net, 'dlindqvist', 'core1') && !GUEST_TEMPLATES.some((t) => ctx.activeTemplates.has(t)) && !ctx.busyPcs.has(CONF) && freePeople(ctx).length > 0 && poolIntact(ctx.net),
  plan: (ctx) => ({ pcId: ctx.rng.pick(freePeople(ctx)).pcId, variant: ctx.rng.int(0, spec.descriptions.length - 1) }),
  build: (env, params) => {
    const net = env.net;
    return {
      templateId: id,
      params,
      kind: 'incident',
      difficulty,
      truePriority: spec.truePriority,
      subject: spec.subject,
      description: variant(spec.descriptions, params),
      reporter: person(env, params.pcId),
      pcs: [CONF],
      inject: () => {
        spec.inject(net);
        net.log('core1', '%SYS-5-CONFIG_I: Configured from console by dlindqvist on vty0 (10.10.99.21)');
        net.commit();
        flushDns(net.device(CONF));
        dhcpRequest(net, CONF);
      },
      check: () => confOnline(net),
      fix: () => restorePool(net),
      explain: spec.explain,
      hint: spec.hint,
    };
  },
});

const noGateway = guestTicket('guest-no-gateway', 'moderate', {
  truePriority: 3,
  subject: 'Conference room PC has no internet',
  descriptions: [
    `I'm in the conference room with a client and the PC in here can't get on the internet. It shows connected but nothing loads. Can someone help ASAP?`,
    `The conference room computer says "No internet" again. We present to a client in 30 minutes.`,
  ],
  inject: (net) => void (pool(net)!.defaultRouter = []),
  explain:
    "The GUEST pool on CR-CORE1 lost its `default-router` line, so the conference room PC got an address and DNS server but no default gateway. It could talk to its own subnet and nothing else. `default-router 10.10.40.1` in `ip dhcp pool GUEST`, then `ipconfig /renew` on the PC.",
  hint: 'Compare `ipconfig /all` on that PC with a working one. Who handed it those settings?',
});

const poolFull = guestTicket('guest-pool-full', 'moderate', {
  truePriority: 2,
  subject: 'Conference room network down for guests and the room PC',
  descriptions: [
    `Our visitors can't get on the network in the conference room, and now the room PC itself says "No internet". It was fine yesterday.`,
    `Client is here for the year-end meeting and their laptop won't connect. The conference room PC isn't working either. Help!`,
  ],
  inject: (net) => {
    // Someone set the guest lease to infinite months ago: every visitor laptop has kept its address since.
    const p = pool(net)!;
    p.leaseMs = null;
    const bindings: Record<string, number> = {};
    for (let ip = parseIp('10.10.40.10')!; ip <= parseIp('10.10.40.254')!; ip++) {
      const n = ip & 0xffff;
      bindings[`c4b3.01${(n >> 8).toString(16).padStart(2, '0')}.${(n & 0xff).toString(16).padStart(2, '0')}77`] = ip;
    }
    core(net).dhcpBindings = { GUEST: bindings };
  },
  explain:
    "The GUEST pool was set to `lease infinite` a while ago, so every visitor's laptop kept its address forever and the pool filled up (`show ip dhcp pool` showed every address leased). When the conference room PC asked again, there was nothing left and it fell back to 169.254. `lease 0 8` puts the 8-hour lease back, `clear ip dhcp binding *` frees the stale leases, then renew the PC.",
  hint: 'A 169.254 address means nobody answered with an address. Is the DHCP server reachable, or does it just have nothing left to give?',
});

const dnsInternal = guestTicket('guest-dns-internal', 'easy', {
  truePriority: 3,
  subject: 'Websites won\'t load in the conference room',
  descriptions: [
    `Conference room PC: every website says "server not found", but Rick says pinging 8.8.8.8 works? I don't know what that means but please fix it.`,
    `Google won't load on the conference room PC. Says it can't find the server. The network icon looks fine.`,
  ],
  inject: (net) => void (pool(net)!.dnsServer = [parseIp('10.10.20.10')!]),
  explain:
    "The GUEST pool's `dns-server` was changed to 10.10.20.10 (CR-DC01). Guests are blocked from everything internal by the GUEST-IN ACL, DNS included, so names failed while raw IPs worked. `dns-server 8.8.8.8` in the pool and a renew fixed it.",
  hint: 'Pinging an IP works, names don\'t. What does the PC use to turn names into addresses, and can it actually reach that?',
});

export const GUEST_TICKETS: TicketTemplate[] = [noGateway, poolFull, dnsInternal];
