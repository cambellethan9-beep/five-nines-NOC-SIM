// Security tickets: locking down unused ports and console/enable passwords, rolling out DHCP snooping and dynamic
// ARP inspection (and the outages they cause when done naively), a rogue DHCP server, an NSOS upgrade from a vendor
// advisory, and a time-based guest ACL.

import { canMakeChange } from './access';
import { evaluate, type Packet } from '../sim/acl';
import { createDevice } from '../sim/devices';
import { dhcpRequest, dhcpServerFor, forceApipa } from '../sim/dhcp';
import { imageFor, RELEASES } from '../sim/images';
import { formatIp, parseIp } from '../sim/ip';
import type { Network } from '../sim/network';
import { canReach } from '../sim/routing';
import { FS01, INTERNET, NIC, freePeople, freePorts, person, reaches, variant, type TicketTemplate, type TemplateContext } from './ticketKit';

const L2_SECURITY = ['snooping-rollout', 'dai-rollout', 'rogue-dhcp', 'dai-printers', 'option82-outage', 'rogue-device', 'moved-desk', 'nsos-upgrade'];
const ACCESS = ['acc1', 'acc2'] as const;
const GEAR = ['rtr1', 'core1', 'acc1', 'acc2'];

const busy = (ctx: TemplateContext, list: string[]) => list.some((t) => ctx.activeTemplates.has(t));
const onFloor = (ctx: TemplateContext, sw: string) => freePeople(ctx).filter((p) => ctx.net.peerOf(p.pcId, NIC)?.device === sw);
const noL2Security = (net: Network) => ACCESS.every((id) => !net.device(id).running.snooping?.enabled && !net.device(id).running.dai?.vlans.length);

/** The access switch's port toward the core. */
export function uplinkOf(net: Network, sw: string): string {
  const d = net.device(sw);
  return Object.keys(d.hardware).find((p) => net.peerOf(sw, p)?.device === 'core1' && !d.running.interfaces[p]?.shutdown && net.isUp(sw, p)) ?? 'GigabitEthernet0/1';
}

/** Access ports with nothing plugged in. */
function emptyPorts(net: Network, sw: string): string[] {
  const d = net.device(sw);
  return Object.keys(d.hardware).filter((p) => p.startsWith('FastEthernet') && !net.linkAt(sw, p));
}

function snoopFloor(net: Network, sw: string, vlans: number[], option82: boolean): void {
  const d = net.device(sw).running;
  d.snooping = { enabled: true, vlans: [...new Set([...(d.snooping?.vlans ?? []), ...vlans])], option82 };
  d.interfaces[uplinkOf(net, sw)].snoopTrust = true;
}

// ---- change requests ------------------------------------------------------------------------

const shutUnused: TicketTemplate = {
  id: 'shut-unused-ports',
  difficulty: 'easy',
  canStart: (ctx) => !ctx.usedTemplates.has('shut-unused-ports') && !busy(ctx, ['shut-unused-ports', 'moved-desk', 'rogue-device', 'rogue-dhcp']) && ACCESS.some((sw) => emptyPorts(ctx.net, sw).some((p) => !ctx.net.device(sw).running.interfaces[p].shutdown)) && freePeople(ctx).length > 0,
  plan: (ctx) => ({ pcId: (ctx.office.people.find((p) => p.title === 'Office Manager' && !ctx.busyPcs.has(p.pcId)) ?? ctx.rng.pick(freePeople(ctx))).pcId }),
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const staff = () => env.office.people.filter((x) => net.peerOf(x.pcId, NIC)).slice(0, 3);
    return {
      templateId: 'shut-unused-ports',
      params,
      kind: 'request',
      difficulty: 'easy',
      truePriority: 4,
      subject: 'Request: disable unused network ports',
      description:
        "After the unknown-device scare, the insurer wants every unused network jack in the building disabled, so nobody can just plug something in. Please turn off every port on the floor switches that doesn't have something connected to it. Facilities will tell us when a new hire needs a desk port turned on.",
      reporter: p,
      pcs: [],
      inject: () => {},
      check: () => ACCESS.every((sw) => emptyPorts(net, sw).every((port) => net.device(sw).running.interfaces[port].shutdown)) && staff().every((s) => reaches(net, s.pcId, FS01)),
      fix: () => {
        for (const sw of ACCESS) for (const port of emptyPorts(net, sw)) net.device(sw).running.interfaces[port].shutdown = true;
        net.commit();
      },
      explain:
        '`show interfaces status | include notconnect` on each floor switch lists the candidates; `interface range` then `shutdown` disables them in one go. Many shops also park them in an unused "blackhole" VLAN with a description like "UNUSED - disabled per audit". Remember to `no shutdown` (and set the VLAN) when a desk needs one.',
      hint: 'Every floor switch can tell you which ports have nothing connected. You can configure a whole range at once.',
    };
  },
};

const passwords: TicketTemplate = {
  id: 'device-passwords',
  difficulty: 'easy',
  canStart: (ctx) => !ctx.usedTemplates.has('device-passwords') && !busy(ctx, ['device-passwords']) && GEAR.some((id) => !ctx.net.device(id).running.enableSecret) && freePeople(ctx).length > 0,
  plan: (ctx) => ({ pcId: (ctx.office.people.find((p) => p.department === 'Partners' && !ctx.busyPcs.has(p.pcId)) ?? ctx.rng.pick(freePeople(ctx))).pcId }),
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const ok = (id: string) => {
      const c = net.device(id).running;
      const con = c.lines.con;
      const conOk = (con.login === 'line' && (con.password?.length ?? 0) >= 10) || (con.login === 'local' && Object.keys(c.users).length > 0);
      return (c.enableSecret?.length ?? 0) >= 10 && conOk;
    };
    return {
      templateId: 'device-passwords',
      params,
      kind: 'request',
      difficulty: 'easy',
      truePriority: 4,
      subject: 'Request: passwords on the network equipment consoles',
      description:
        'Our new security policy says every piece of network equipment needs a privileged (enable) password stored securely, and a password on the console port, both at least 10 characters. Right now anyone who walks into a closet with a console cable gets straight in. Please set this on the router and all three switches, and record the passwords in the password manager.',
      reporter: p,
      pcs: [],
      inject: () => {},
      check: () => GEAR.every(ok) && canReach(net, 'noc', parseIp('10.10.99.11')!, { proto: 'tcp', port: 22 }),
      fix: () => {
        for (const id of GEAR) {
          const c = net.device(id).running;
          c.enableSecret = 'Cedar!Enable2026';
          c.lines.con.password = 'Cedar!Console26';
          c.lines.con.login = 'line';
        }
      },
      explain:
        "On each device: `enable secret <password>` (type 5 hash, unlike `enable password`), and under `line con 0` either `password <password>` + `login` or `login local` to use the local username database. `security passwords min-length 10` makes the device enforce the policy from now on. The SSH key login for nocadmin keeps working: it doesn't use either password.",
      hint: 'Two places: the privileged EXEC password and the console line. One kind of enable password is stored far more safely than the other.',
    };
  },
};

const snoopingRollout: TicketTemplate = {
  id: 'snooping-rollout',
  difficulty: 'hard',
  canStart: (ctx) => !ctx.usedTemplates.has('snooping-rollout') && !busy(ctx, L2_SECURITY) && noL2Security(ctx.net) && ACCESS.every((sw) => onFloor(ctx, sw).length > 0),
  plan: (ctx) => ({ pcId: ctx.rng.pick(freePeople(ctx)).pcId, a: ctx.rng.pick(onFloor(ctx, 'acc1')).pcId, b: ctx.rng.pick(onFloor(ctx, 'acc2')).pcId }),
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const pcs = [String(params.a), String(params.b)];
    return {
      templateId: 'snooping-rollout',
      params,
      kind: 'request',
      difficulty: 'hard',
      truePriority: 4,
      subject: 'Change request: enable DHCP snooping on the floor switches',
      description:
        "Following last month's rogue-router scare, our MSP recommends DHCP snooping on the staff VLAN (10) on both floor switches, so only our real DHCP server can hand out addresses. Please roll it out. Everyone must still be able to get an address afterwards, obviously.",
      reporter: p,
      pcs,
      inject: () => {},
      check: () =>
        ACCESS.every((sw) => {
          const s = net.device(sw).running.snooping;
          return !!s?.enabled && s.vlans.includes(10);
        }) && pcs.every((pc) => dhcpServerFor(net, pc) === parseIp('10.10.20.10')),
      fix: () => {
        for (const sw of ACCESS) snoopFloor(net, sw, [10], false);
        net.commit();
      },
      explain:
        "`ip dhcp snooping`, `ip dhcp snooping vlan 10`, and `ip dhcp snooping trust` on each switch's uplink to the core (the DHCP replies arrive there; untrusted ports drop server messages). The trap: by default the switch inserts option 82 with a zero giaddr, and the core, as the relay, drops those requests unless it trusts them. Fix with `no ip dhcp snooping information option` on the access switches, or `ip dhcp relay information trust-all` on the core. `show ip dhcp snooping binding` fills up as PCs renew.",
      hint: 'Test it with a real renewal before closing. If nobody gets an address, ask yourself which ports the server replies come in on, and what the switch adds to the request on its way up.',
    };
  },
};

const daiRollout: TicketTemplate = {
  id: 'dai-rollout',
  difficulty: 'expert',
  canStart: (ctx) => !ctx.usedTemplates.has('dai-rollout') && !busy(ctx, L2_SECURITY) && !ctx.net.device('acc1').running.dai?.vlans.length && onFloor(ctx, 'acc1').length > 0,
  plan: (ctx) => ({ pcId: ctx.rng.pick(onFloor(ctx, 'acc1')).pcId }),
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    return {
      templateId: 'dai-rollout',
      params,
      kind: 'request',
      difficulty: 'expert',
      truePriority: 4,
      subject: 'Change request: ARP spoofing protection on the 1st floor',
      description:
        "The penetration testers poisoned ARP on the 1st floor and read traffic between staff and the file server. Their report recommends Dynamic ARP Inspection on CR-ACC1 for the staff VLAN (10) and the printer VLAN (30). Please implement it without breaking anything: staff need the file server, and the copy room printer must keep working.",
      reporter: p,
      pcs: [p.pcId],
      inject: () => {},
      check: () => {
        const d = net.device('acc1');
        const ok = !!d.running.snooping?.enabled && [10, 30].every((v) => d.running.dai?.vlans.includes(v) && d.running.snooping?.vlans.includes(v));
        return ok && !d.errDisabled?.[uplinkOf(net, 'acc1')] && reaches(net, p.pcId, FS01, '10.10.30.21');
      },
      fix: () => {
        const d = net.device('acc1');
        snoopFloor(net, 'acc1', [10, 30], false);
        d.running.interfaces[uplinkOf(net, 'acc1')].daiTrust = true;
        if (d.errDisabled) delete d.errDisabled[uplinkOf(net, 'acc1')];
        const prn = net.device('prn1');
        const mac = prn.hardware[Object.keys(prn.hardware)[0]].mac;
        d.running.arpAcls = { ...d.running.arpAcls, PRINTERS: [{ action: 'permit', ip: parseIp('10.10.30.21'), mac }] };
        d.running.dai = { vlans: [10, 30], filters: [{ acl: 'PRINTERS', vlans: [30], static: false }], validate: [] };
        net.commit();
        dhcpRequest(net, p.pcId);
      },
      explain:
        "DAI checks every ARP on untrusted ports against the DHCP snooping bindings, so it needs snooping first (`ip dhcp snooping`, `vlan 10,30`, trust the uplink, and mind option 82 at the relay). Then `ip arp inspection vlan 10,30` and `ip arp inspection trust` on the uplink: an untrusted uplink sees the whole office's ARP, blows the 15 pps limit and err-disables (`%SW_DAI-4-PACKET_RATE_EXCEEDED`). PCs whose leases predate snooping have no binding until they renew, so bounce their ports or have them renew. The printer has a static address and never gets a binding: an ARP ACL (`arp access-list`, `ip arp inspection filter ... vlan 30`) or `ip source binding` lets it through.",
      hint: 'DAI trusts what DHCP snooping learned. Think about who on that floor never talks DHCP, and which port sees everyone\'s ARP.',
    };
  },
};

const ADVISORY = 'NSSA-2026-0414-SW';

const upgrade: TicketTemplate = {
  id: 'nsos-upgrade',
  difficulty: 'hard',
  canStart: (ctx) => !busy(ctx, ['nsos-upgrade']) && ACCESS.some((sw) => ctx.net.device(sw).image !== RELEASES['NS-S2900'].at(-1)!.file && onFloor(ctx, sw).length > 0),
  plan: (ctx) => {
    const sw = ctx.rng.pick(ACCESS.filter((s) => ctx.net.device(s).image !== RELEASES['NS-S2900'].at(-1)!.file && onFloor(ctx, s).length > 0));
    return { sw, pcId: ctx.rng.pick(onFloor(ctx, sw)).pcId };
  },
  build: (env, params) => {
    const net = env.net;
    const sw = String(params.sw);
    const p = person(env, params.pcId);
    const target = RELEASES['NS-S2900'].at(-1)!;
    const md5 = imageFor('NS-S2900', target.file)!.md5;
    const host = sw === 'acc1' ? 'CR-ACC1' : 'CR-ACC2';
    return {
      templateId: 'nsos-upgrade',
      params,
      kind: 'request',
      difficulty: 'hard',
      truePriority: 4,
      subject: `Change request: NSOS security upgrade for ${host}`,
      description: [
        `NetSmart security advisory ${ADVISORY} (critical): NSOS 15.0(2)SE releases on the NS-S2900 allow remote code execution through the web management service. Fixed in ${target.version}.`,
        '',
        `Please upgrade ${host} to NSOS ${target.version}:`,
        `  Image file: ${target.file}`,
        `  Size: ${target.size} bytes`,
        `  MD5: ${md5}`,
        '  The image is already in the TFTP root on the NOC PC (10.10.99.50).',
        '',
        `Marty approved the reload now: that floor is in the all-hands meeting for the next hour. The switch must come back on the new version with everyone online.`,
      ].join('\n'),
      reporter: p,
      pcs: [p.pcId],
      inject: () => {},
      check: () => {
        const d = net.device(sw);
        return d.image === target.file && net.isOnline(d) && reaches(net, p.pcId, FS01);
      },
      fix: () => {
        const d = net.device(sw);
        d.images = { [target.file]: imageFor('NS-S2900', target.file)! };
        d.image = target.file;
        d.running.bootSystem = [`flash:${target.file}`];
        d.startup = structuredClone(d.running);
        d.rommon = false;
        net.commit();
      },
      explain: `The NS-S2900's flash can't hold two images, so the old one had to go first (\`delete flash:<old image>\`; the switch keeps running from RAM). Then \`copy tftp://10.10.99.50/${target.file} flash:\`, \`verify /md5 flash:${target.file} ${md5}\` to make sure the copy is intact, \`boot system flash:${target.file}\`, \`write memory\` and \`reload\`. \`show version\` afterwards shows ${target.version}. Reloading with no good image on flash lands you in ROMMON at the console.`,
      hint: 'Check how much room flash has before copying. Never reload until the new image is verified and the boot settings point at it.',
    };
  },
};

/** The guest internet packet at a given time, through CR-CORE1's guest ACL. */
function guestAllowedAt(net: Network, date: Date): boolean {
  const core = net.device('core1').running;
  const name = core.interfaces['Vlan40']?.accessGroup?.in;
  const acl = name ? core.acls?.[name] : undefined;
  if (!acl) return true;
  const pkt: Packet = { proto: 'tcp', src: parseIp('10.10.40.10')!, dst: parseIp(INTERNET)!, srcPort: 51034, dstPort: 443 };
  return evaluate(acl, pkt, { now: date, ranges: core.timeRanges ?? {}, acls: core.acls ?? {} }).permit;
}

const guestHours: TicketTemplate = {
  id: 'guest-hours',
  difficulty: 'moderate',
  canStart: (ctx) => !ctx.usedTemplates.has('guest-hours') && !busy(ctx, ['guest-hours', 'guest-no-gateway', 'guest-pool-full', 'guest-dns-internal']) && freePeople(ctx).length > 0,
  plan: (ctx) => ({ pcId: (ctx.office.people.find((p) => p.title === 'Office Manager' && !ctx.busyPcs.has(p.pcId)) ?? ctx.rng.pick(freePeople(ctx))).pcId }),
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const at = (day: number, hour: number) => new Date(Date.UTC(2026, 3, 12 + day, hour, 15)); // Apr 12 2026 is a Sunday
    return {
      templateId: 'guest-hours',
      params,
      kind: 'request',
      difficulty: 'moderate',
      truePriority: 4,
      subject: 'Request: guest network only during office hours',
      description:
        "Someone has been sitting in the parking lot at night using our guest network. Please make the guest network's internet access work only on weekdays between 7:00 and 19:00. During office hours guests should notice no difference.",
      reporter: p,
      pcs: [],
      inject: () => {},
      check: () => guestAllowedAt(net, at(2, 10)) && guestAllowedAt(net, at(5, 18)) && !guestAllowedAt(net, at(2, 21)) && !guestAllowedAt(net, at(2, 5)) && !guestAllowedAt(net, at(6, 11)) && !guestAllowedAt(net, at(0, 11)),
      fix: () => {
        const core = net.device('core1').running;
        core.timeRanges = { ...core.timeRanges, 'OFFICE-HOURS': { periodic: [{ days: ['weekdays'], from: '7:00', to: '19:00' }], absolute: null } };
        const acl = core.acls!['GUEST-IN'];
        acl.entries = acl.entries.map((e) => (e.action === 'permit' && e.proto === 'ip' && e.dst?.wildcard === 0xffffffff ? { ...e, timeRange: 'OFFICE-HOURS' } : e));
        net.commit();
      },
      explain:
        "A `time-range OFFICE-HOURS` with `periodic weekdays 7:00 to 19:00`, then the guest ACL's internet permit gets `time-range OFFICE-HOURS` (`40 permit ip 10.10.40.0 0.0.0.255 any time-range OFFICE-HOURS` in GUEST-IN on CR-CORE1). Outside the range that entry is skipped and the implicit deny drops the traffic. Time ranges follow the switch's own clock, which is why NTP matters: an unsynced switch thinks it's 1993.",
      hint: 'IOS ACL entries can be tied to a schedule. Whose clock decides what time it is?',
    };
  },
};

// ---- incidents --------------------------------------------------------------------------------

const rogueDhcp: TicketTemplate = {
  id: 'rogue-dhcp',
  difficulty: 'hard',
  canStart: (ctx) => !busy(ctx, L2_SECURITY) && noL2Security(ctx.net) && ACCESS.some((sw) => freePorts(ctx.net, sw).length && onFloor(ctx, sw).length > 1),
  plan: (ctx) => {
    const sw = ctx.rng.pick(ACCESS.filter((s) => freePorts(ctx.net, s).length && onFloor(ctx, s).length > 1));
    const people = onFloor(ctx, sw);
    const pc = ctx.rng.pick(people).pcId;
    return { sw, port: ctx.rng.pick(freePorts(ctx.net, sw)), pcId: pc, other: people.find((x) => x.pcId !== pc)!.pcId, rogue: `homerouter${ctx.rng.int(10, 99)}`, variant: ctx.rng.int(0, 1) };
  },
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const other = String(params.other);
    const id = String(params.rogue);
    const sw = String(params.sw);
    const port = String(params.port);
    return {
      templateId: 'rogue-dhcp',
      params,
      kind: 'incident',
      difficulty: 'hard',
      truePriority: 2,
      subject: 'No internet or S: drive after restarting',
      description: variant(
        [
          `I restarted my PC and now nothing works. My IP shows as 192.168.1.something, which I'm pretty sure isn't right. Two people near me have the same thing.`,
          `After a reboot I have no network drives and no internet. ipconfig says my gateway is 192.168.1.1?`,
        ],
        params,
      ),
      reporter: p,
      pcs: [p.pcId, other],
      inject: () => {
        if (!net.devices.has(id)) {
          const r = net.addDevice(createDevice(id, 'NS-PC', 'Linksys-E1200'));
          const nic = Object.keys(r.hardware)[0];
          r.hardware[nic].mac = `586d.8fa1.${String(params.rogue).slice(-2).padStart(4, '0')}`;
          r.running.interfaces[nic].ip = { address: parseIp('192.168.1.1')!, prefix: 24 };
          r.dhcpServer = { scopes: [{ network: parseIp('192.168.1.0')!, prefix: 24, start: parseIp('192.168.1.100')!, end: parseIp('192.168.1.149')!, gateway: parseIp('192.168.1.1')!, dns: parseIp('192.168.1.1')!, reservations: {}, leases: {} }] };
          // Someone's home router, plugged into an empty desk port that Facilities had patched for a new hire.
          const ifc = net.device(sw).running.interfaces[port];
          ifc.shutdown = false;
          if (ifc.switchport) {
            ifc.switchport.mode = 'access';
            ifc.switchport.accessVlan = 10;
          }
          net.connect(id, nic, sw, port);
          net.commit();
        }
        dhcpRequest(net, p.pcId);
        dhcpRequest(net, other);
      },
      check: () => dhcpServerFor(net, p.pcId) === parseIp('10.10.20.10') && dhcpServerFor(net, other) === parseIp('10.10.20.10') && reaches(net, p.pcId, FS01, INTERNET) && reaches(net, other, FS01, INTERNET),
      fix: () => {
        net.device(sw).running.interfaces[port].shutdown = true;
        net.commit();
        dhcpRequest(net, p.pcId);
        dhcpRequest(net, other);
      },
      explain: `A consumer router plugged into ${sw === 'acc1' ? 'CR-ACC1' : 'CR-ACC2'} ${port.replace('FastEthernet', 'Fa')} was running its own DHCP server and answering faster than the real one (relayed by the core), handing out 192.168.1.x with itself as the gateway. ipconfig /all on an affected PC names the DHCP server (192.168.1.1); its MAC in \`show mac address-table\` leads to the port. Shutting the port and renewing the PCs fixed it; DHCP snooping (trusting only the uplink) stops it from happening again.`,
      hint: 'A PC can tell you which DHCP server gave it its address. Find where that server is plugged in.',
    };
  },
};

const daiPrinters: TicketTemplate = {
  id: 'dai-printers',
  difficulty: 'moderate',
  canStart: (ctx) => !busy(ctx, L2_SECURITY) && noL2Security(ctx.net) && ACCESS.some((sw) => onFloor(ctx, sw).length > 0 && canMakeChange(ctx.net, 'msp-secops', sw)),
  plan: (ctx) => {
    const sw = ctx.rng.pick(ACCESS.filter((s) => onFloor(ctx, s).length > 0 && canMakeChange(ctx.net, 'msp-secops', s)));
    return { sw, pcId: ctx.rng.pick(onFloor(ctx, sw)).pcId, variant: ctx.rng.int(0, 1) };
  },
  build: (env, params) => {
    const net = env.net;
    const sw = String(params.sw);
    const p = person(env, params.pcId);
    const prn = sw === 'acc1' ? '10.10.30.21' : '10.10.30.22';
    return {
      templateId: 'dai-printers',
      params,
      kind: 'incident',
      difficulty: 'moderate',
      truePriority: 3,
      subject: 'Copy room printer offline',
      description: variant(
        [
          'The printer in our copy room shows as offline on everyone\'s PC since this morning. It says Ready on its own screen and it can still copy.',
          'Nobody on our floor can print. The printer itself looks fine, the queue just says "Printer offline".',
        ],
        params,
      ),
      reporter: p,
      pcs: [p.pcId],
      inject: () => {
        // The MSP's security engineer turned on DAI for the printer VLAN last night, carefully trusting the uplink.
        const d = net.device(sw);
        snoopFloor(net, sw, [30], false);
        d.running.interfaces[uplinkOf(net, sw)].daiTrust = true;
        d.running.dai = { vlans: [30], filters: [], validate: [] };
        net.log(sw, '%SYS-5-CONFIG_I: Configured from console by msp-secops on vty0 (10.10.99.21)');
        net.commit();
      },
      check: () => reaches(net, p.pcId, prn),
      fix: () => {
        const d = net.device(sw);
        const printer = [...net.devices.values()].find((x) => x.kind === 'printer' && Object.values(x.running.interfaces).some((i) => i.ip && formatIp(i.ip.address) === prn))!;
        const mac = printer.hardware[Object.keys(printer.hardware)[0]].mac;
        d.running.arpAcls = { ...d.running.arpAcls, PRINTERS: [{ action: 'permit', ip: parseIp(prn), mac }] };
        d.running.dai!.filters = [{ acl: 'PRINTERS', vlans: [30], static: false }];
        net.commit();
      },
      explain: `Dynamic ARP inspection was enabled for VLAN 30 on ${sw === 'acc1' ? 'CR-ACC1' : 'CR-ACC2'}. DAI only trusts addresses learned by DHCP snooping, and the printer has a static IP, so its ARP replies were dropped (\`%SW_DAI-4-DHCP_SNOOPING_DENY\` in the logs, invalid ARPs from the printer's MAC). An ARP ACL permitting the printer's IP and MAC, applied with \`ip arp inspection filter PRINTERS vlan 30\`, fixed it (a static \`ip source binding\` works too).`,
      hint: 'The printer is fine and so is its port. Look at the switch logs for something dropping its traffic, and at what was changed last night.',
    };
  },
};

const option82: TicketTemplate = {
  id: 'option82-outage',
  difficulty: 'hard',
  canStart: (ctx) => canMakeChange(ctx.net, 'msp-secops', 'acc2') && !busy(ctx, L2_SECURITY) && noL2Security(ctx.net) && onFloor(ctx, 'acc2').length > 1,
  plan: (ctx) => {
    const people = onFloor(ctx, 'acc2');
    const pc = ctx.rng.pick(people).pcId;
    return { pcId: pc, other: people.find((x) => x.pcId !== pc)!.pcId };
  },
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const other = String(params.other);
    return {
      templateId: 'option82-outage',
      params,
      kind: 'incident',
      difficulty: 'hard',
      truePriority: 2,
      subject: '2nd floor: PCs coming back from lunch have no network',
      description: `Several of us on the 2nd floor came back from lunch, woke our PCs and have no network at all: "No Internet", no S: drive. People who never put their PC to sleep are fine.`,
      reporter: p,
      pcs: [p.pcId, other],
      inject: () => {
        // DHCP snooping went in over lunch, uplink trusted, everything else left at defaults.
        snoopFloor(net, 'acc2', [10], true);
        net.log('acc2', '%SYS-5-CONFIG_I: Configured from console by msp-secops on vty0 (10.10.99.21)');
        net.commit();
        forceApipa(net, p.pcId);
        forceApipa(net, other);
      },
      check: () => reaches(net, p.pcId, FS01, INTERNET) && reaches(net, other, FS01, INTERNET),
      fix: () => {
        net.device('acc2').running.snooping!.option82 = false;
        net.commit();
        dhcpRequest(net, p.pcId);
        dhcpRequest(net, other);
      },
      explain:
        "Someone enabled DHCP snooping on CR-ACC2 for VLAN 10 and trusted the uplink, but left option 82 insertion on (the default). The switch adds option 82 with a zero giaddr; CR-CORE1, relaying to the DC, drops those requests because it doesn't trust relay information on that interface. Only PCs that asked for a lease after the change broke: they fell back to APIPA (169.254.x.x). `no ip dhcp snooping information option` on CR-ACC2 (or `ip dhcp relay information trust-all` on the core) fixed it; then the PCs needed to renew.",
      hint: 'Only machines that asked for an address recently are broken. What changed on that floor, and what does it add to a DHCP request?',
    };
  },
};

export const SECURITY_TICKETS: TicketTemplate[] = [shutUnused, passwords, snoopingRollout, daiRollout, upgrade, guestHours, rogueDhcp, daiPrinters, option82];
