// Tickets caused by NAT on CR-RTR1: the NAT ACL narrowed, overload dropped, `ip nat inside` removed.

import { parseIp } from '../sim/ip';
import type { NatRule } from '../sim/nat';
import type { Network } from '../sim/network';
import { reachService } from './services';
import { FS01, INTERNET, NIC, freePeople, person, reaches, variant, withAwake, type TicketTemplate } from './ticketKit';

const rtr = (net: Network) => net.device('rtr1');
const PAT: NatRule = { kind: 'dynamic', acl: '1', iface: 'GigabitEthernet0/1', overload: true };

/** The predecessor's PAT setup is still in place (so a NAT ticket has something to break). */
function patIntact(net: Network): boolean {
  const r = rtr(net).running;
  const acl1 = r.acls?.['1'];
  return (
    r.interfaces['GigabitEthernet0/0'].nat === 'inside' &&
    !!acl1 &&
    acl1.entries.length === 1 &&
    acl1.entries[0].src?.addr === parseIp('10.10.0.0') &&
    (r.nat?.rules ?? []).some((x) => JSON.stringify(x) === JSON.stringify(PAT))
  );
}

function otherStaff(net: Network, people: { pcId: string }[], pcId: string): string {
  const floor = net.peerOf(pcId, NIC)?.device;
  const others = people.filter((p) => p.pcId !== pcId);
  return (others.find((p) => net.peerOf(p.pcId, NIC)?.device !== floor) ?? others[0]).pcId;
}

const twoPeople: TicketTemplate['plan'] = (ctx) => {
  const pcId = ctx.rng.pick(freePeople(ctx)).pcId;
  return { pcId, other: otherStaff(ctx.net, freePeople(ctx), pcId), variant: ctx.rng.int(0, 1) };
};

/** One NAT ticket at a time, and only while the original PAT setup is intact. */
const canStart: TicketTemplate['canStart'] = (ctx) =>
  !['nat-acl-narrowed', 'nat-no-overload', 'nat-inside-missing'].some((t) => ctx.activeTemplates.has(t)) && patIntact(ctx.net) && freePeople(ctx).length > 1;

function restorePat(net: Network): void {
  const r = rtr(net).running;
  r.interfaces['GigabitEthernet0/0'].nat = 'inside';
  r.interfaces['GigabitEthernet0/1'].nat = 'outside';
  (r.acls ??= {})['1'] = { name: '1', type: 'standard', named: false, entries: [{ seq: 10, action: 'permit', src: { addr: parseIp('10.10.0.0')!, wildcard: parseIp('0.0.255.255')! } }] };
  r.nat = { pools: r.nat?.pools ?? {}, rules: [...(r.nat?.rules ?? []).filter((x) => x.kind !== 'dynamic'), PAT] };
  rtr(net).natTable = [];
  net.commit();
}

const aclNarrowed: TicketTemplate = {
  id: 'nat-acl-narrowed',
  difficulty: 'moderate',
  canStart,
  plan: twoPeople,
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const other = String(params.other);
    return {
      templateId: 'nat-acl-narrowed',
      params,
      kind: 'incident',
      difficulty: 'moderate',
      truePriority: 1,
      subject: 'Internet down for everyone',
      description: variant(
        [
          `No websites, no email, nothing from outside. The S: drive and LedgerWorks still open fine. Everyone in our area has the same thing.`,
          `Is the internet down? Outlook says disconnected and Google won't load, but I can still get to our shared drive.`,
        ],
        params,
      ),
      reporter: p,
      pcs: [p.pcId, other],
      inject: () => {
        // "Only the new backup server needs to get out" - someone rewrote ACL 1 for it.
        rtr(net).running.acls!['1'].entries = [{ seq: 10, action: 'permit', src: { addr: parseIp('10.10.20.0')!, wildcard: 255 } }];
        rtr(net).natTable = [];
        net.log('rtr1', '%SYS-5-CONFIG_I: Configured from console by dlindqvist on vty0 (10.10.99.21)');
        net.commit();
      },
      check: () => reaches(net, p.pcId, INTERNET, FS01) && reaches(net, other, INTERNET),
      fix: () => restorePat(net),
      explain:
        "CR-RTR1 translates whatever access list 1 permits. Someone rewrote it to `access-list 1 permit 10.10.20.0 0.0.0.255` (just the server VLAN, for a new backup job), so staff traffic left the building with a private 10.10.10.x source and the replies had nowhere to go. `access-list 1 permit 10.10.0.0 0.0.255.255` puts everyone back. `show ip nat translations` only had server addresses in it.",
      hint: 'Inside things work, outside things don\'t. Who turns 10.x addresses into something the internet can answer, and who decides which addresses qualify?',
    };
  },
};

const noOverload: TicketTemplate = {
  id: 'nat-no-overload',
  difficulty: 'hard',
  canStart,
  plan: twoPeople,
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const other = String(params.other);
    // Each user really tries the internet (that's what fills the translation table).
    const online = (pc: string) => withAwake(net, [pc], () => reachService(net, pc, INTERNET, true));
    return {
      templateId: 'nat-no-overload',
      params,
      kind: 'incident',
      difficulty: 'hard',
      truePriority: 2,
      subject: 'Internet works for someone else but not me',
      description: variant(
        [
          `My internet is out but the person across from me is browsing fine. I've restarted twice. Same for a few others on our floor.`,
          `Websites won't load for me or anyone near me, but apparently one person in the office has internet. How?`,
        ],
        params,
      ),
      reporter: p,
      pcs: [p.pcId, other],
      inject: () => {
        const r = rtr(net).running;
        r.nat!.rules = r.nat!.rules.map((x) => (x.kind === 'dynamic' ? { ...x, overload: false } : x));
        rtr(net).natTable = []; // changing the mapping clears the dynamic translations
        net.log('rtr1', '%SYS-5-CONFIG_I: Configured from console by dlindqvist on vty0 (10.10.99.21)');
        net.commit();
      },
      check: () => online(p.pcId) && online(other),
      fix: () => restorePat(net),
      explain:
        "The NAT rule on CR-RTR1 lost its `overload` keyword: `ip nat inside source list 1 interface GigabitEthernet0/1`. Without overload, dynamic NAT maps one inside address to the one WAN address, so whoever got there first had the internet and everyone else's traffic was dropped (`show ip nat statistics` showed the misses). Putting `overload` back (PAT) lets everyone share the address by port, then `clear ip nat translation *` frees the stuck entry.",
      hint: 'One person works and everyone else fails, all through the same router. How many people can share one public address, and what makes that possible?',
    };
  },
};

const insideMissing: TicketTemplate = {
  id: 'nat-inside-missing',
  difficulty: 'easy',
  canStart,
  plan: twoPeople,
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const other = String(params.other);
    return {
      templateId: 'nat-inside-missing',
      params,
      kind: 'incident',
      difficulty: 'easy',
      truePriority: 1,
      subject: 'No internet anywhere in the office',
      description: variant(
        [
          `Nobody can get on the internet. Email is down too. The S: drive works.`,
          `Internet is down for the whole office since about 20 minutes ago. Clients can't reach us by email either.`,
        ],
        params,
      ),
      reporter: p,
      pcs: [p.pcId, other],
      inject: () => {
        // An interface "cleanup" on the router dropped a line that looked unimportant.
        delete rtr(net).running.interfaces['GigabitEthernet0/0'].nat;
        rtr(net).natTable = [];
        net.log('rtr1', '%SYS-5-CONFIG_I: Configured from console by dlindqvist on vty0 (10.10.99.21)');
        net.commit();
      },
      check: () => reaches(net, p.pcId, INTERNET) && reaches(net, other, INTERNET),
      fix: () => restorePat(net),
      explain:
        "`ip nat inside` was missing from CR-RTR1 GigabitEthernet0/0 (the link to the core). NAT only translates traffic that comes in an inside interface and leaves an outside one, so nothing was translated and the ISP dropped our private-sourced packets. `show ip nat statistics` listed no inside interfaces.",
      hint: 'NAT needs to know which side is which. Check how CR-RTR1 thinks of each of its interfaces.',
    };
  },
};

export const NAT_TEMPLATES: TicketTemplate[] = [aclNarrowed, noOverload, insideMissing];
