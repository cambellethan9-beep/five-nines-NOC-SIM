// Time and the carrier: a switch whose clock drifted after losing NTP, and an ISP outage you can only prove and
// report (the carrier's network isn't yours: call them with the circuit ID, then keep people informed).

import { ISP } from '../content/office';
import { canMakeChange } from './access';
import { parseIp } from '../sim/ip';
import { ntpState } from '../sim/mgmt';
import type { Network } from '../sim/network';
import { INTERNET, freePeople, person, reaches, variant, type TicketTemplate } from './ticketKit';

const DC = '10.10.20.10';

/** The ISP's upstream port (towards the rest of the internet). Ours to see, not to touch. */
export const ISP_UPSTREAM = 'GigabitEthernet0/1';

export function ispDown(net: Network): boolean {
  return net.device('isp').running.interfaces[ISP_UPSTREAM].shutdown;
}

export function restoreIsp(net: Network): void {
  net.device('isp').running.interfaces[ISP_UPSTREAM].shutdown = false;
  net.commit();
}

const ntpDrift: TicketTemplate = {
  id: 'ntp-drift',
  difficulty: 'moderate',
  canStart: (ctx) =>
    !ctx.activeTemplates.has('ntp-drift') &&
    freePeople(ctx).length > 0 &&
    canMakeChange(ctx.net, 'msp-secops', 'acc1') &&
    (ctx.net.device('acc1').running.ntp?.servers ?? []).some((s) => s.ip === parseIp(DC)) &&
    ntpState(ctx.net, ctx.net.device('acc1')).synced,
  plan: (ctx) => ({ pcId: (ctx.office.people.find((p) => p.department === 'Partners' && !ctx.busyPcs.has(p.pcId)) ?? ctx.rng.pick(freePeople(ctx))).pcId, minutes: ctx.rng.int(38, 57), variant: ctx.rng.int(0, 1) }),
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const sw = () => net.device('acc1');
    const mins = Number(params.minutes);
    return {
      templateId: 'ntp-drift',
      params,
      kind: 'request',
      difficulty: 'moderate',
      truePriority: 3,
      subject: 'Switch log times are off (MSP SecOps finding)',
      description: variant(
        [
          `Forwarding this from our MSP's security team: "CR-ACC1's syslog timestamps are about ${mins} minutes ahead of every other device, so we can't correlate its events with the firewall and the DC during investigations. Please restore time sync and confirm." Can the NOC take care of it?`,
          `The MSP's SecOps people flagged that one of our switches (CR-ACC1) logs with the wrong time, roughly ${mins} minutes off. They say it breaks their incident timelines. Please fix and let me know.`,
        ],
        params,
      ),
      reporter: p,
      pcs: [p.pcId],
      inject: () => {
        // During last week's DC migration someone pointed it at the new DC's planned address, which never came up.
        // After a power blip it booted with a wrong calendar and has nothing to correct it.
        const d = sw();
        d.running.ntp = { servers: [{ ip: parseIp('10.10.20.15')!, prefer: false }], master: d.running.ntp?.master ?? null };
        d.clockSetAt = net.time;
        d.clockOffset = mins * 60_000;
        net.log('acc1', '%SYS-5-CONFIG_I: Configured from console by msp-secops on vty0 (10.10.99.27)');
        net.commit();
      },
      check: () => ntpState(net, sw()).synced,
      fix: () => {
        const d = sw();
        d.running.ntp = { servers: [{ ip: parseIp(DC)!, prefer: false }], master: d.running.ntp?.master ?? null };
        net.commit();
      },
      explain: `CR-ACC1 pointed at NTP server 10.10.20.15, an address from the DC migration plan that never came up, so it had no time source and ran on a clock ${mins} minutes fast. \`show ntp associations\` showed nothing synced. \`no ntp server 10.10.20.15\` and \`ntp server ${DC}\` (CR-DC01, what everything else uses) brought it back in line.`,
      hint: 'Compare `show clock` and `show ntp associations` on CR-ACC1 with a switch that has the right time. Where does each get its time from?',
    };
  },
};

const ispOutage: TicketTemplate = {
  id: 'isp-outage',
  difficulty: 'moderate',
  canStart: (ctx) => !ispDown(ctx.net) && !ctx.activeTemplates.has('isp-outage') && freePeople(ctx).length > 1,
  plan: (ctx) => {
    const people = freePeople(ctx);
    const pcId = ctx.rng.pick(people).pcId;
    return { pcId, other: people.find((p) => p.pcId !== pcId)!.pcId, variant: ctx.rng.int(0, 1) };
  },
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const other = String(params.other);
    return {
      templateId: 'isp-outage',
      params,
      kind: 'incident',
      difficulty: 'moderate',
      truePriority: 1,
      subject: 'Internet down for everyone',
      description: variant(
        [
          'No internet anywhere in the office. Websites, email, Teams, all of it. The S: drive and LedgerWorks are fine.',
          'Is the internet out? Nothing outside loads for anyone on our floor, but our own files open.',
        ],
        params,
      ),
      reporter: p,
      pcs: [p.pcId, other],
      inject: () => {
        // A backhoe somewhere upstream: Brightline's side of the network, not ours. Our WAN link stays up.
        net.device('isp').running.interfaces[ISP_UPSTREAM].shutdown = true;
        net.commit({ silent: true });
      },
      check: () => reaches(net, p.pcId, INTERNET) && reaches(net, other, INTERNET),
      fix: () => restoreIsp(net),
      explain: `${ISP.name} had an outage upstream of our circuit. Our side was clean: CR-RTR1's WAN link up, ${ISP.gateway} answering ping, but a traceroute to 8.8.8.8 died right after their router. The fix is theirs: open a carrier ticket on ${ISP.support} with the circuit ID (${ISP.circuit}), tell everyone it's the provider and give the ETR, and confirm when it's back.`,
      hint: 'Everyone, internet only. Walk out hop by hop with traceroute. Where does it stop, and whose equipment is that?',
    };
  },
};

export const UPSTREAM_TICKETS: TicketTemplate[] = [ntpDrift, ispOutage];
