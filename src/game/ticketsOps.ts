// Operations tickets: a duplex mismatch, hunting an unknown device down by its MAC address, getting config backups
// onto the TFTP server, and a security audit of the internet-facing router.

import { createDevice } from '../sim/devices';
import { dhcpRequest } from '../sim/dhcp';
import { configText } from '../sim/backup';
import { cleartextPasswords, execTimeoutMs } from '../sim/hardening';
import { parseIp } from '../sim/ip';
import { canReach } from '../sim/routing';
import { FS01, NIC, freePeople, freePorts, person, reaches, variant, type TicketTemplate } from './ticketKit';

const SERVERS = [
  { id: 'fs01', port: 'FastEthernet0/2', ip: '10.10.20.11', what: 'the S: drive' },
  { id: 'app01', port: 'FastEthernet0/3', ip: '10.10.20.12', what: 'LedgerWorks' },
];

const duplex: TicketTemplate = {
  id: 'duplex-mismatch',
  difficulty: 'moderate',
  canStart: (ctx) =>
    !ctx.activeTemplates.has('duplex-mismatch') &&
    !ctx.activeTemplates.has('fs-speed') &&
    SERVERS.every((s) => !ctx.net.duplexMismatch('core1', s.port) && ctx.net.isUp('core1', s.port)) &&
    freePeople(ctx).length > 0,
  plan: (ctx) => ({ pcId: ctx.rng.pick(freePeople(ctx)).pcId, server: ctx.rng.int(0, SERVERS.length - 1), variant: ctx.rng.int(0, 1) }),
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const s = SERVERS[Number(params.server)];
    const port = () => net.device('core1').running.interfaces[s.port];
    const short = s.port.replace('FastEthernet', 'Fa');
    return {
      templateId: 'duplex-mismatch',
      params,
      kind: 'incident',
      difficulty: 'moderate',
      truePriority: 2,
      subject: s.id === 'fs01' ? 'S: drive is painfully slow' : 'LedgerWorks keeps freezing',
      description: variant(
        s.id === 'fs01'
          ? [
              `Opening anything on the S: drive takes forever, and a 20 MB client file took five minutes to copy. Sometimes Explorer just hangs. It's like this for everyone near me.`,
              `The shared drive is crawling since this morning. Files open eventually but saving fails half the time with "network path not found".`,
            ]
          : [
              `LedgerWorks keeps freezing for 10-20 seconds and sometimes kicks me out with a connection error. It's slow for everyone.`,
              `LedgerWorks is unusable this morning. Every screen takes ages and timesheets fail to save about half the time.`,
            ],
        params,
      ),
      reporter: p,
      pcs: [p.pcId],
      inject: () => {
        // "Hard-coded for performance" during last night's maintenance; the server's NIC is still on auto.
        port().speed = 100;
        port().duplex = 'full';
        net.log('core1', '%SYS-5-CONFIG_I: Configured from console by dlindqvist on vty0 (10.10.99.21)');
        net.commit();
      },
      check: () => !net.duplexMismatch('core1', s.port) && net.isUp('core1', s.port) && reaches(net, p.pcId, s.ip),
      fix: () => {
        port().speed = 'auto';
        port().duplex = 'auto';
        net.commit();
      },
      explain: `CR-CORE1 ${short} had been hard-coded to \`speed 100\` and \`duplex full\`. With duplex hard-coded the switch stops autonegotiating, so the server's NIC (still on auto) could only sense the speed and fell back to half duplex. Full on one end and half on the other is a duplex mismatch: the full side counts CRC errors and runts, the half side late collisions, and everything above it gets slow and lossy without the link ever going down. Setting both \`speed auto\` and \`duplex auto\` on the port fixed it (hard-coding both ends the same would too).`,
      hint: 'The link is up and pings mostly work, so look closer at the port itself. What do its error counters say, and what duplex did each end end up at?',
    };
  },
};

/** A free desk port with nothing in it and the rogue's id. */
function roguePlan(ctx: Parameters<TicketTemplate['plan']>[0]) {
  const options = (['acc1', 'acc2'] as const).flatMap((sw) => freePorts(ctx.net, sw).map((port) => ({ sw, port })));
  const pick = ctx.rng.pick(options);
  const n = ctx.rng.int(0x10, 0xff).toString(16).padStart(2, '0');
  const m = ctx.rng.int(0x1000, 0xffff).toString(16).padStart(4, '0');
  return { sw: pick.sw, port: pick.port, mac: `3c22.fb${n}.${m}`, rogue: `rogue${ctx.rng.int(100, 999)}`, hostname: `DESKTOP-${ctx.rng.int(1000000, 9999999).toString(36).toUpperCase()}` };
}

const rogue: TicketTemplate = {
  id: 'rogue-device',
  difficulty: 'moderate',
  canStart: (ctx) => !ctx.activeTemplates.has('rogue-device') && !ctx.activeTemplates.has('moved-desk') && freePorts(ctx.net, 'acc1').length + freePorts(ctx.net, 'acc2').length > 0 && freePeople(ctx).length > 0,
  plan: (ctx) => ({ ...roguePlan(ctx), pcId: (ctx.office.people.find((p) => p.department === 'Partners' && !ctx.busyPcs.has(p.pcId)) ?? ctx.rng.pick(freePeople(ctx))).pcId }),
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const id = String(params.rogue);
    const sw = String(params.sw);
    const port = String(params.port);
    const mac = String(params.mac);
    const neighbor = () => env.office.people.find((x) => net.peerOf(x.pcId, NIC)?.device === sw);
    return {
      templateId: 'rogue-device',
      params,
      kind: 'incident',
      difficulty: 'moderate',
      truePriority: 2,
      subject: 'Security alert: unknown device on the staff network',
      description: `Our MSP's security scan flagged a device we don't own on the staff network: hostname ${params.hostname}, MAC ${mac}. It pulled a DHCP lease this morning and has been scanning ports on the file server. Nobody here recognizes it. Please find where it's plugged in and cut it off without taking anyone else down.`,
      reporter: p,
      pcs: [],
      inject: () => {
        if (!net.devices.has(id)) {
          const d = net.addDevice(createDevice(id, 'NS-PC', String(params.hostname)));
          const nic = Object.keys(d.hardware)[0];
          d.hardware[nic].mac = mac;
          d.hostNet = { dhcp: true, lease: null, apipa: false, dnsServer: null, dnsCache: {} };
          d.powered = true;
          // Facilities patched the empty desk for a new hire yesterday and nobody locked it down again.
          const ifc = net.device(sw).running.interfaces[port];
          ifc.shutdown = false;
          if (ifc.switchport) {
            ifc.switchport.mode = 'access';
            ifc.switchport.accessVlan = 10;
          }
          net.connect(id, nic, sw, port);
          net.commit();
          dhcpRequest(net, id);
        }
      },
      check: () => {
        if (!net.devices.has(id)) return true;
        const isolated = !canReach(net, id, parseIp(FS01)!) && !canReach(net, id, parseIp('10.10.10.1')!);
        const n = neighbor();
        return isolated && (!n || reaches(net, n.pcId, FS01));
      },
      fix: () => {
        net.device(sw).running.interfaces[port].shutdown = true;
        net.commit();
      },
      explain: `The device was plugged into ${sw === 'acc1' ? 'CR-ACC1' : 'CR-ACC2'} ${port.replace('FastEthernet', 'Fa')}, an empty desk port someone had put in VLAN 10. \`show mac address-table address ${mac}\` on CR-CORE1 points down the uplink to the access switch, and the same command there names the port. Shutting it (or err-disabling it with port security) cut it off; then tell security which desk it's at so someone can pick the box up.`,
      hint: 'You have a MAC address. Every switch knows which port each MAC lives behind. Start at the core and follow it.',
    };
  },
};

const NETWORK_GEAR = ['rtr1', 'core1', 'acc1', 'acc2'];

const backups: TicketTemplate = {
  id: 'config-backups',
  difficulty: 'easy',
  canStart: (ctx) => !ctx.usedTemplates.has('config-backups') && !ctx.activeTemplates.has('config-backups') && freePeople(ctx).length > 0,
  plan: (ctx) => ({ pcId: (ctx.office.people.find((p) => p.title === 'Office Manager' && !ctx.busyPcs.has(p.pcId)) ?? ctx.rng.pick(freePeople(ctx))).pcId }),
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const noc = () => net.device('noc');
    return {
      templateId: 'config-backups',
      params,
      kind: 'request',
      difficulty: 'easy',
      truePriority: 4,
      subject: 'Request: back up the network configs',
      description:
        "Our insurer's cyber questionnaire asks whether we keep backups of our network device configurations. As far as I know we've never had any. There's a TFTP server running on the NOC PC (10.10.99.50); please get a copy of the configs of the router and all three switches onto it. Bonus points if it keeps happening on its own.",
      reporter: p,
      pcs: [],
      inject: () => {},
      check: () => NETWORK_GEAR.every((id) => Object.values(noc().files ?? {}).some((f) => f.from === id)),
      fix: () => {
        for (const id of NETWORK_GEAR) {
          const d = net.device(id);
          d.running.archive = { path: 'tftp://10.10.99.50/$h', writeMemory: true, timePeriod: 1440, maximum: null };
          const name = `${d.running.hostname}-1`;
          (noc().files ??= {})[name] = { text: configText(d, d.running), config: structuredClone(d.running), time: net.time, from: id };
          d.archiveFiles = [`tftp://10.10.99.50/${name}`];
          d.archiveNext = 2;
          d.archiveAt = net.time;
        }
      },
      explain:
        "`copy running-config tftp:` on each device puts a copy on the NOC PC's TFTP server. To keep it going, an `archive` block does it automatically: `path tftp://10.10.99.50/$h` (the hostname), `write-memory` to archive on every save, and `time-period 1440` for a daily copy. `show archive` lists what's been written.",
      hint: 'IOS can copy its configuration to a TFTP server, and it can be told to do that by itself.',
    };
  },
};

const audit: TicketTemplate = {
  id: 'hardening-audit',
  difficulty: 'hard',
  canStart: (ctx) => !ctx.usedTemplates.has('hardening-audit') && !ctx.activeTemplates.has('hardening-audit') && freePeople(ctx).length > 0,
  plan: (ctx) => ({ pcId: (ctx.office.people.find((p) => p.department === 'Partners' && !ctx.busyPcs.has(p.pcId)) ?? ctx.rng.pick(freePeople(ctx))).pcId }),
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const rtr = () => net.device('rtr1').running;
    return {
      templateId: 'hardening-audit',
      params,
      kind: 'request',
      difficulty: 'hard',
      truePriority: 3,
      subject: 'Audit findings on the edge router (CR-RTR1)',
      description: [
        'The external auditors finished their review of CR-RTR1 and we need these closed before they come back:',
        '1. Passwords are stored in clear text in the configuration.',
        '2. Remote management sessions never time out. Policy is 15 minutes or less.',
        '3. No protection against password guessing: the router logs failed logins from the internet all day.',
        '4. No legal warning is shown before someone logs in.',
        "Please don't lock the NOC out while you're at it.",
      ].join('\n'),
      reporter: p,
      pcs: [],
      inject: () => {},
      check: () => {
        const cfg = rtr();
        const timeout = execTimeoutMs(cfg.lines.vty);
        const ssh = canReach(net, 'noc', parseIp('10.0.0.1')!, { proto: 'tcp', port: 22 });
        return cleartextPasswords(cfg) === 0 && timeout > 0 && timeout <= 15 * 60000 && !!cfg.loginBlock && !!cfg.bannerLogin?.trim() && ssh;
      },
      fix: () => {
        const cfg = rtr();
        cfg.servicePasswordEncryption = true;
        for (const u of Object.values(cfg.users)) if (u.password !== null) u.passwordEncrypted = true;
        for (const l of [cfg.lines.con, cfg.lines.vty]) if (l.password) l.passwordEncrypted = true;
        cfg.lines.vty.execTimeout = [10, 0];
        cfg.loginBlock = { blockFor: 120, attempts: 5, within: 60, quietAcl: null };
        cfg.bannerLogin = 'Authorized access only. Activity is logged and monitored.';
      },
      explain:
        "Four commands on CR-RTR1: `service password-encryption` (the predecessor's `username backup password 0 ...` became type 7; better still, replace it with `secret`), `exec-timeout 10 0` under `line vty 0 15` (it was `exec-timeout 0 0`, never), `login block-for 120 attempts 5 within 60` to go quiet after repeated failures (add `login quiet-mode access-class` permitting the NOC PC so an attack can't lock you out too), and a `banner login`. The MOTD banner doesn't count for SSH: IOS shows it after authentication, while the login banner appears before.",
      hint: 'Each finding maps to one IOS command. Check where each banner type appears for an SSH user.',
    };
  },
};

export const OPS_TICKETS: TicketTemplate[] = [duplex, rogue, backups, audit];
