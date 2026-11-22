// The ticket library: each template breaks something real in the network (or asks for a change),
// knows how to check that it's actually fixed, and how a senior would fix it.
// True priority is hard-coded from real impact; the service desk's priority may differ.
//
// Templates are split into plan() (random choices, stored as plain params) and build() (turns params
// into the live ticket), so a ticket can be saved and rebuilt exactly.

import { defaultInterfaceConfig } from '../sim/devices';
import { parseIp } from '../sim/ip';
import { CURRENT_NIC_DRIVER } from '../sim/types';
import { dhcpRequest, forceApipa } from '../sim/dhcp';
import { reachService } from './services';
import { ACL_TEMPLATES } from './ticketsAcl';
import { NAT_TEMPLATES } from './ticketsNat';
import { GUEST_TICKETS } from './ticketsGuest';
import { ROUTING_TICKETS } from './ticketsRouting';
import { SWITCHING_TICKETS } from './ticketsSwitching';
import { OPS_TICKETS } from './ticketsOps';
import { SECURITY_TICKETS } from './ticketsSecurity';
import { PHYSICAL_TICKETS } from './ticketsPhysical';
import { flushDns, resolve } from '../sim/dns';
import {
  FS01, INTERNET, NIC, floorOf, freePeople, freePorts, person, pickPerson, portLabel, reaches, userIncident,
  userTicket, variant, withAwake,
  type Env, type Params, type TicketDraft, type TicketTemplate,
} from './ticketKit';

export type { Env, Params, TemplateContext, TicketDraft, TicketTemplate } from './ticketKit';

// ---- switch-side user problems -------------------------------------------------------------

/** Also used for the tutorial ticket, whose fault is built into the office. */
export const portShutdown = userTicket('port-shutdown', 'trivial', (env, params) => {
  const net = env.net;
  const p = person(env, params.pcId);
  const port = () => {
    const peer = net.peerOf(p.pcId, NIC)!;
    return net.device(peer.device).running.interfaces[peer.iface];
  };
  return userIncident(env, params, {
    templateId: 'port-shutdown',
    difficulty: 'trivial',
    truePriority: 3,
    subject: 'No internet or S: drive at my desk',
    explain: `${portLabel(net, p.pcId)} was administratively shut down. \`no shutdown\` on that port brought the user back.`,
    hint: 'Start at their switch port. `show interfaces status` on the access switch shows every port at a glance.',
    description: variant(
      [
        `My computer says no internet and I can't open the S: drive. Can someone look? Thanks!`,
        `Nothing is loading on my PC. Outlook is offline and the S: drive is gone. Everyone around me seems fine.`,
        `My network icon has a red X on it. I already restarted twice.`,
      ],
      params,
    ),
    inject: () => {
      if (params.alreadyBroken) return;
      port().shutdown = true;
      net.commit();
    },
    fix: () => {
      port().shutdown = false;
      net.commit();
    },
  });
});

const wrongVlan: TicketTemplate = {
  ...userTicket('wrong-vlan', 'easy', (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const sp = () => {
      const peer = net.peerOf(p.pcId, NIC)!;
      return net.device(peer.device).running.interfaces[peer.iface].switchport!;
    };
    return userIncident(env, params, {
      templateId: 'wrong-vlan',
      difficulty: 'easy',
      truePriority: 3,
      subject: 'PC lost network after lunch',
      explain: `${portLabel(net, p.pcId)} had been moved to VLAN ${params.badVlan}. Staff ports belong in VLAN 10.`,
      hint: 'The link light is on, so the cable is fine. What VLAN is their port in?',
      description: variant(
        [
          `It was working this morning. Now I get "no internet" and can't open any client files.`,
          `Came back from lunch and my PC can't reach anything. Network cable is plugged in, the light is on.`,
        ],
        params,
      ),
      inject: () => {
        sp().accessVlan = Number(params.badVlan);
        net.commit();
      },
      fix: () => {
        sp().accessVlan = 10;
        net.commit();
      },
    });
  }),
  plan: (ctx) => ({ ...pickPerson(ctx), badVlan: ctx.rng.pick([20, 30]) }),
};

const movedDesk: TicketTemplate = {
  id: 'moved-desk',
  difficulty: 'moderate',
  canStart: (ctx) => freePeople(ctx).length > 0 && freePorts(ctx.net, 'acc1').length + freePorts(ctx.net, 'acc2').length > 0,
  plan: (ctx) => {
    const p = ctx.rng.pick(freePeople(ctx));
    const from = floorOf(ctx.net, p.pcId);
    const other = from === 'acc1' ? 'acc2' : 'acc1';
    const to = freePorts(ctx.net, other).length ? other : from;
    const port = ctx.rng.pick(freePorts(ctx.net, to));
    const desk = `${to === 'acc1' ? 1 : 2}-${String(Number(port.split('/')[1])).padStart(2, '0')}`;
    return { pcId: p.pcId, to, port, desk };
  },
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const sw = net.device(String(params.to));
    const port = String(params.port);
    return {
      templateId: 'moved-desk',
      params,
      kind: 'incident',
      difficulty: 'moderate',
      truePriority: 3,
      subject: `Moved to desk ${params.desk}, no network`,
      explain: `The port at desk ${params.desk} (${String(params.to) === 'acc1' ? 'CR-ACC1' : 'CR-ACC2'} ${String(params.port).replace('FastEthernet', 'Fa')}) had never been configured, so it was still in VLAN 1, and the PC had given up on DHCP and taken a 169.254.x.x address. Put the port in VLAN 10, then renew the PC's address (\`ipconfig /renew\`, or bounce the port).`,
      hint: 'New desk, new switch port. What VLAN is an unused port in by default?',
      description: `Hi! I moved to the empty desk ${params.desk} this morning to sit with my team. Plugged everything back in the same way but my PC can't connect to anything now.`,
      reporter: p,
      pcs: [p.pcId],
      inject: () => {
        net.disconnect(p.pcId, NIC);
        net.connect(p.pcId, NIC, sw.id, port);
        p.desk = String(params.desk);
        net.commit();
        // Plugged in at the new desk: Windows asks for an address. Nobody answers in VLAN 1.
        dhcpRequest(net, p.pcId);
      },
      check: () => reaches(net, p.pcId, FS01, INTERNET),
      fix: () => {
        const ifc = sw.running.interfaces[port];
        ifc.switchport!.mode = 'access';
        ifc.switchport!.accessVlan = 10;
        ifc.shutdown = false;
        net.commit();
        dhcpRequest(net, p.pcId);
      },
    };
  },
};

// ---- desk-side problems (need a visit, or a helpful user) -------------------------------------

const cableUnplugged = userTicket('cable-unplugged', 'trivial', (env, params) => {
  const net = env.net;
  const link = () => net.linkAt(String(params.pcId), NIC)!;
  return userIncident(env, params, {
    templateId: 'cable-unplugged',
    difficulty: 'trivial',
    truePriority: 3,
    subject: 'Computer says network cable unplugged',
    explain: 'The patch cable had come out of the PC\'s network card. Plugged it back in.',
    hint: '"Network cable unplugged" usually means exactly that. Ask them to check, or walk over.',
    description: variant(
      [
        `My computer says "Network cable unplugged". The cleaning crew was here last night, not sure if that matters.`,
        `Little popup says the network cable is unplugged?? I didn't touch anything.`,
        `I moved my tower to clean under my desk and now there's no internet.`,
      ],
      params,
    ),
    inject: () => {
      link().cable = 'unplugged';
      net.commit();
    },
    fix: () => {
      link().cable = 'ok';
      net.commit();
    },
  });
});

const badCable = userTicket('bad-cable', 'easy', (env, params) => {
  const net = env.net;
  const link = () => net.linkAt(String(params.pcId), NIC)!;
  return userIncident(env, params, {
    templateId: 'bad-cable',
    difficulty: 'easy',
    truePriority: 3,
    subject: 'Network dead at my desk',
    explain: 'The patch cable under the desk was crushed by the chair. Swapped in a new one.',
    hint: 'Plugged in at both ends but no link light? Suspect the cable itself.',
    description: variant(
      [
        `My network kept dropping all week and now it's just dead. My chair keeps rolling over the cable, if that's a thing.`,
        `No network. The cable is plugged in on both ends, I checked. There's a weird kink in it under my desk.`,
      ],
      params,
    ),
    inject: () => {
      link().cable = 'cut';
      net.commit();
    },
    fix: () => {
      link().cable = 'ok';
      net.commit();
    },
  });
});

const nicDisabled = userTicket('nic-disabled', 'trivial', (env, params) => {
  const net = env.net;
  const pc = () => net.device(String(params.pcId));
  return userIncident(env, params, {
    templateId: 'nic-disabled',
    difficulty: 'trivial',
    truePriority: 3,
    subject: 'Internet gone after I changed a setting',
    explain: 'The network adapter had been disabled in Windows. Enabled it in Device Manager.',
    hint: 'The switch port looks fine and the network icon is gone entirely. Look at the PC, not the network.',
    description: variant(
      [
        `I was trying to make my wifi faster (found a guide online) and now there's no internet at all. Oops?`,
        `My network icon disappeared completely. I might have clicked something in the settings.`,
      ],
      params,
    ),
    inject: () => {
      pc().nic!.disabled = true;
      net.commit();
    },
    fix: () => {
      pc().nic!.disabled = false;
      net.commit();
    },
  });
});

const driverOutdated = userTicket('driver-outdated', 'easy', (env, params) => {
  const net = env.net;
  const pc = () => net.device(String(params.pcId));
  return userIncident(env, params, {
    templateId: 'driver-outdated',
    difficulty: 'easy',
    truePriority: 3,
    subject: 'Network broke after Windows update',
    explain: 'Windows Update rolled the network driver back to 3.9.0, which can\'t start this card (Code 10). Installed 4.2.1 from the toolkit USB.',
    hint: 'After an update, check Device Manager. Remember a PC with no network can\'t download its own driver.',
    description: variant(
      [
        `Windows did a big update overnight and now my network doesn't work. Everyone else is fine.`,
        `After the restart for updates this morning, no internet. The cable light on the back is off.`,
      ],
      params,
    ),
    inject: () => {
      // The update rolled the adapter back to a driver that can't start this card.
      pc().nic!.driver = 'outdated';
      pc().nic!.version = '3.9.0';
      net.commit();
    },
    fix: () => {
      pc().nic!.driver = 'ok';
      pc().nic!.version = CURRENT_NIC_DRIVER;
      net.commit();
    },
  });
});

const newPcNoDriver = userTicket('driver-missing', 'easy', (env, params) => {
  const net = env.net;
  const pc = () => net.device(String(params.pcId));
  return userIncident(env, params, {
    templateId: 'driver-missing',
    difficulty: 'easy',
    truePriority: 3,
    subject: 'Replacement PC has no network',
    explain: 'The replacement PC had no network driver installed, so Windows didn\'t even see the adapter. Installed it from the toolkit USB.',
    hint: 'No network icon at all on a new PC: does Windows even know it has a network card?',
    description: `The desktop team dropped off my replacement PC this morning. They said it's "all set up" but there's no network at all, not even the icon.`,
    inject: () => {
      pc().nic!.driver = 'missing';
      pc().nic!.version = '';
      net.commit();
    },
    fix: () => {
      pc().nic!.driver = 'ok';
      pc().nic!.version = CURRENT_NIC_DRIVER;
      net.commit();
    },
  });
});

// ---- addressing and name resolution ------------------------------------------------------------

const apipaBlip = userTicket('apipa-blip', 'trivial', (env, params) => {
  const net = env.net;
  const p = person(env, params.pcId);
  return userIncident(env, params, {
    templateId: 'apipa-blip',
    difficulty: 'trivial',
    truePriority: 3,
    subject: 'Still no network after the blip this morning',
    description: variant(
      [
        `There was a network blip this morning. Everyone else came back but my computer still says "No internet".`,
        `My PC lost the network for a second earlier and never came back. Others around me are fine.`,
      ],
      params,
    ),
    inject: () => forceApipa(net, p.pcId),
    fix: () => void dhcpRequest(net, p.pcId),
    explain: `${p.pc}'s PC asked for an address during a brief outage, got no answer, and fell back to a 169.254.x.x (APIPA) address. Windows doesn't keep retrying; \`ipconfig /renew\` got it a real lease.`,
    hint: 'Check what IP their PC actually has. An address starting with 169.254 means DHCP never answered.',
  });
});

const wrongGateway = userTicket('wrong-gateway', 'easy', (env, params) => {
  const net = env.net;
  const p = person(env, params.pcId);
  const pc = () => net.device(p.pcId);
  return userIncident(env, params, {
    templateId: 'wrong-gateway',
    difficulty: 'easy',
    truePriority: 3,
    subject: 'No internet or S: drive since the contractor visit',
    description: variant(
      [
        `I can't get to the internet or the S: drive. An IT contractor "fixed" my network settings yesterday.`,
        `Nothing outside my computer works. Someone from the vendor changed something on my PC last week.`,
      ],
      params,
    ),
    inject: () => {
      const d = pc();
      const addr = d.running.interfaces[NIC].ip;
      // Set to static with the old gateway from before the core switch took over routing.
      Object.assign(d.hostNet!, { dhcp: false, lease: null, apipa: false, dnsServer: parseIp('10.10.20.10') });
      d.running.interfaces[NIC].ip = addr;
      d.running.defaultGateway = parseIp('10.10.10.254');
      net.commit({ silent: true });
    },
    fix: () => {
      pc().hostNet!.dhcp = true;
      dhcpRequest(net, p.pcId);
    },
    explain: `${p.pc} had been set to a static address with default gateway 10.10.10.254. The staff VLAN's gateway is 10.10.10.1 (CR-CORE1). Set it back to "Obtain an IP address automatically".`,
    hint: 'Nothing outside their own subnet answers. Compare their default gateway with the one in the docs.',
  });
});

const staleDns = userTicket('stale-dns', 'easy', (env, params) => {
  const net = env.net;
  const p = person(env, params.pcId);
  const pc = () => net.device(p.pcId);
  const name = 'ledgerworks.cedarridge.local';
  return {
    ...userIncident(env, params, {
      templateId: 'stale-dns',
      difficulty: 'easy',
      truePriority: 3,
      subject: 'LedgerWorks won\'t connect, only for me',
      description: `LedgerWorks says "cannot connect to server" on my computer, but the person next to me can use it fine. I already closed and reopened it.`,
      inject: () => {
        // A cached answer from before LedgerWorks moved servers last month, with a very long TTL.
        pc().hostNet!.dnsCache[name] = { ip: parseIp('10.10.20.99')!, expires: net.time + 48 * 60 * 60_000 };
      },
      fix: () => flushDns(pc()),
      explain: `${p.pc}'s DNS cache still had ledgerworks pointing at 10.10.20.99, the old server from before last month's move. \`nslookup\` asks the DNS server directly and showed the right address (10.10.20.12); \`ipconfig /displaydns\` showed the stale entry, and \`ipconfig /flushdns\` cleared it.`,
      hint: 'It works for the person next to them, so the server is fine. How does their PC find LedgerWorks? Compare what `nslookup ledgerworks` says with what `ping ledgerworks` uses.',
    }),
    check: () =>
      withAwake(net, [p.pcId], () => {
        const r = resolve(net, p.pcId, name);
        return r.ok && r.ip === parseIp('10.10.20.12') && reachService(net, p.pcId, '10.10.20.12');
      }),
  };
});

const helperMissing: TicketTemplate = {
  id: 'helper-missing',
  difficulty: 'moderate',
  canStart: (ctx) =>
    !ctx.activeTemplates.has('helper-missing') &&
    (ctx.net.device('core1').running.interfaces['Vlan10']?.helpers ?? []).length > 0 &&
    freePeople(ctx).length > 0,
  plan: pickPerson,
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const svi = () => net.device('core1').running.interfaces['Vlan10'];
    return {
      templateId: 'helper-missing',
      params,
      kind: 'incident',
      difficulty: 'moderate',
      truePriority: 2,
      subject: 'PC restarted and now nothing works',
      description: `My computer restarted for updates and now nothing works. I've restarted it twice more, no luck.`,
      reporter: p,
      pcs: [p.pcId],
      inject: () => {
        // A config "cleanup" on the core removed the DHCP relay for the staff VLAN.
        svi().helpers = [];
        net.commit();
        dhcpRequest(net, p.pcId);
      },
      check: () => reaches(net, p.pcId, FS01, INTERNET),
      fix: () => {
        svi().helpers = [parseIp('10.10.20.10')!];
        net.commit();
        for (const d of net.devices.values()) if (d.hostNet?.dhcp && d.hostNet.apipa) dhcpRequest(net, d.id);
      },
      explain: `Someone removed \`ip helper-address 10.10.20.10\` from CR-CORE1's Vlan10 interface, so DHCP requests from the staff VLAN never reached CR-DC01. Every PC that rebooted or woke up got a 169.254 address. Put the helper back, then renew the affected PCs.`,
      hint: '169.254 means no DHCP answer, and the DHCP server lives in a different VLAN. How do DHCP broadcasts cross VLANs?',
    };
  },
};

// ---- bigger problems --------------------------------------------------------------------------

const printerPort: TicketTemplate = {
  id: 'printer-port',
  difficulty: 'easy',
  canStart: (ctx) => !ctx.activeTemplates.has('printer-port') && !ctx.activeTemplates.has('printer-vlan') && freePeople(ctx).length > 0,
  plan: (ctx) => ({ ...pickPerson(ctx), shut: ctx.rng.chance(0.5) }),
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const floor = floorOf(net, p.pcId);
    const printerIp = floor === 'acc1' ? '10.10.30.21' : '10.10.30.22';
    const port = () => net.device(floor).running.interfaces['FastEthernet0/20'];
    return {
      templateId: 'printer-port',
      params,
      kind: 'incident',
      difficulty: 'easy',
      truePriority: 3,
      subject: `Can't print on the ${floor === 'acc1' ? '1st' : '2nd'} floor`,
      explain: `The printer's port, ${floor === 'acc1' ? 'CR-ACC1' : 'CR-ACC2'} Fa0/20, was ${params.shut ? 'shut down' : 'moved to VLAN 10'}. Printers live in VLAN 30.`,
      hint: 'One printer down for a whole floor: look at that printer\'s switch port.',
      description: `The copy room printer shows as offline for everyone on our floor. I have client packets to print before 3!`,
      reporter: p,
      pcs: [p.pcId],
      inject: () => {
        if (params.shut) port().shutdown = true;
        else port().switchport!.accessVlan = 10;
        net.commit();
      },
      check: () => reaches(net, p.pcId, printerIp),
      fix: () => {
        port().shutdown = false;
        port().switchport!.accessVlan = 30;
        net.commit();
      },
    };
  },
};

const printerVlanDown: TicketTemplate = {
  id: 'printer-vlan',
  difficulty: 'easy',
  canStart: (ctx) => !ctx.activeTemplates.has('printer-port') && !ctx.activeTemplates.has('printer-vlan') && freePeople(ctx).length > 0,
  plan: pickPerson,
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const svi = () => net.device('core1').running.interfaces['Vlan30'];
    return {
      templateId: 'printer-vlan',
      params,
      kind: 'incident',
      difficulty: 'easy',
      truePriority: 2,
      subject: 'No printers work anywhere',
      explain: 'The VLAN 30 interface on CR-CORE1 was shut down, so nothing could route to the printers. `no shutdown` on interface Vlan30 fixed it.',
      hint: 'Both printers down at once means something they share. What routes traffic to VLAN 30?',
      description: `Neither printer works, upstairs or downstairs. Both say offline on every PC we've tried.`,
      reporter: p,
      pcs: [p.pcId],
      inject: () => {
        svi().shutdown = true;
        net.commit();
      },
      check: () => reaches(net, p.pcId, '10.10.30.21', '10.10.30.22'),
      fix: () => {
        svi().shutdown = false;
        net.commit();
      },
    };
  },
};

const trunkPruned: TicketTemplate = {
  id: 'trunk-pruned',
  difficulty: 'moderate',
  canStart: (ctx) => !ctx.activeTemplates.has('trunk-pruned') && freePeople(ctx).length > 0,
  plan: pickPerson,
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const floor = floorOf(net, p.pcId);
    const floorName = floor === 'acc1' ? '1st' : '2nd';
    const uplink = () => net.device(floor).running.interfaces['GigabitEthernet0/1'].switchport!;
    return {
      templateId: 'trunk-pruned',
      params,
      kind: 'incident',
      difficulty: 'moderate',
      truePriority: 2,
      subject: `Whole ${floorName} floor is offline`,
      explain: `Someone trimmed the allowed VLANs on the ${floor === 'acc1' ? 'CR-ACC1' : 'CR-ACC2'} uplink (Gi0/1) and left out VLAN 10. The printer kept working because VLAN 30 was still allowed.`,
      hint: 'Whole floor down but the printer works: compare what the uplink trunk carries. `show interfaces trunk`.',
      description: `Nobody on the ${floorName} floor can get to anything. Internet, S: drive, LedgerWorks, all of it. The printer still shows online, weirdly.`,
      reporter: p,
      pcs: [p.pcId],
      inject: () => {
        // A "cleanup" of the uplink's allowed VLANs that forgot the staff VLAN.
        uplink().allowedVlans = [1, 20, 30, 99];
        net.commit();
      },
      check: () => reaches(net, p.pcId, FS01, INTERNET),
      fix: () => {
        uplink().allowedVlans = 'all';
        net.commit();
      },
    };
  },
};

const defaultRouteGone: TicketTemplate = {
  id: 'default-route',
  difficulty: 'moderate',
  canStart: (ctx) =>
    !['default-route', 'ospf-passive-default', 'ospf-hello-mismatch', 'ospf-area-mismatch', 'ospf-default-missing', 'bgp-migration'].some((t) => ctx.activeTemplates.has(t)) &&
    ctx.net.device('rtr1').running.staticRoutes.some((r) => r.prefix === 0),
  plan: (ctx) => {
    const tom = ctx.office.people.find((p) => p.name === 'Tom Brennan')!;
    return { pcId: ctx.busyPcs.has(tom.pcId) ? ctx.rng.pick(freePeople(ctx)).pcId : tom.pcId };
  },
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const rtr = net.device('rtr1');
    return {
      templateId: 'default-route',
      params,
      kind: 'incident',
      difficulty: 'moderate',
      truePriority: 1,
      subject: 'Internet is down for the whole office',
      explain: 'CR-RTR1\'s default route to the ISP had been deleted. Added `ip route 0.0.0.0 0.0.0.0 203.0.113.1` back.',
      hint: 'Internal things work, the internet doesn\'t. Follow the path out: `show ip route` on the router.',
      description: `No one can get to any websites, and client emails are bouncing. The S: drive still works. This is a big problem, we have filings due today.`,
      reporter: p,
      pcs: [p.pcId],
      inject: () => {
        rtr.running.staticRoutes = rtr.running.staticRoutes.filter((r) => r.prefix !== 0);
        net.commit();
      },
      check: () => reaches(net, p.pcId, INTERNET),
      fix: () => {
        rtr.running.staticRoutes.push({ network: 0, prefix: 0, nextHop: parseIp('203.0.113.1'), exitIf: null, distance: 1 });
        net.commit();
      },
    };
  },
};

const fileServerSpeed: TicketTemplate = {
  id: 'fs-speed',
  difficulty: 'moderate',
  canStart: (ctx) => !ctx.activeTemplates.has('fs-speed') && !ctx.activeTemplates.has('duplex-mismatch') && freePeople(ctx).length > 0,
  plan: pickPerson,
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const corePort = () => net.device('core1').running.interfaces['FastEthernet0/2'];
    return {
      templateId: 'fs-speed',
      params,
      kind: 'incident',
      difficulty: 'moderate',
      truePriority: 1,
      subject: 'S: drive is gone for everyone',
      explain: 'CR-CORE1 Fa0/2 was hard-set to 10 Mb while the file server was hard-set to 100. Two different hard-coded speeds never link up. Set the switch port back to auto.',
      hint: 'Server unreachable for everyone: start at the server\'s switch port. Compare both ends.',
      description: `The S: drive disappeared for all of us. Client files won't open. The server team says they only changed a NIC setting on CR-FS01 last night.`,
      reporter: p,
      pcs: [p.pcId],
      inject: () => {
        // The server was hard-set to 100 Mb; someone had already pinned the switch port to 10.
        net.device('fs01').running.interfaces['GigabitEthernet0'].speed = 100;
        corePort().speed = 10;
        net.commit();
      },
      check: () => reaches(net, p.pcId, FS01),
      fix: () => {
        corePort().speed = 'auto';
        net.commit();
      },
    };
  },
};

const partnerVlan: TicketTemplate = {
  id: 'partner-vlan',
  difficulty: 'expert',
  canStart: (ctx) => !ctx.usedTemplates.has('partner-vlan'),
  plan: () => ({}),
  build: (env) => {
    const net = env.net;
    const diane = env.office.people.find((p) => p.name === 'Diane Cedar')!;
    const robert = env.office.people.find((p) => p.name === 'Robert Ridge')!;
    const plan = [
      { person: diane, ip: '10.10.50.19' },
      { person: robert, ip: '10.10.50.20' },
    ];
    const reIp = () => {
      for (const p of plan) {
        const pc = net.device(p.person.pcId);
        pc.running.interfaces[NIC].ip = { address: parseIp(p.ip)!, prefix: 24 };
        pc.running.defaultGateway = parseIp('10.10.50.1');
        if (pc.hostNet) Object.assign(pc.hostNet, { dhcp: false, lease: null, apipa: false, dnsServer: parseIp('10.10.20.10') });
      }
      net.commit({ silent: true });
    };
    return {
      templateId: 'partner-vlan',
      params: {},
      kind: 'request',
      difficulty: 'expert',
      truePriority: 4,
      subject: 'Change request: separate network for the partners',
      explain: 'Created VLAN 50 (PARTNERS) on CR-CORE1 and CR-ACC2, gave CR-CORE1 a VLAN 50 interface at 10.10.50.1, and moved the partners\' two ports into VLAN 50. (Routing it on CR-RTR1 with a subinterface works too, but that subinterface then needs `ip nat inside` or the partners get no internet.)',
      hint: 'The VLAN has to exist on every switch in the path, it needs a gateway, and the ports have to move. Router-on-a-stick works too if the router has a trunk.',
      description: [
        `Our insurer wants the partners' PCs on their own network segment. Please set up:`,
        `- VLAN 50 named PARTNERS, subnet 10.10.50.0/24, gateway 10.10.50.1 on CR-CORE1`,
        `- Move CR-WS19 (Diane) and CR-WS20 (Robert) into it`,
        `- They still need the S: drive, LedgerWorks and the internet`,
        `The desktop team will re-IP the two PCs to 10.10.50.19 and 10.10.50.20 as soon as you resolve this ticket.`,
      ].join('\n'),
      reporter: diane,
      pcs: [diane.pcId, robert.pcId],
      inject: () => {},
      check: () => {
        // Simulate the desktop team's re-IP. Keep it if everything works, roll back if not.
        const before = plan.map((p) => {
          const pc = net.device(p.person.pcId);
          return { pc, ip: pc.running.interfaces[NIC].ip, gw: pc.running.defaultGateway, hostNet: structuredClone(pc.hostNet) };
        });
        reIp();
        const ok = withAwake(net, plan.map((p) => p.person.pcId), () =>
          plan.every((p) => ['10.10.20.11', '10.10.20.12', INTERNET].every((t) => reachService(net, p.person.pcId, t))),
        );
        if (!ok) {
          for (const b of before) {
            b.pc.running.interfaces[NIC].ip = b.ip;
            b.pc.running.defaultGateway = b.gw;
            b.pc.hostNet = b.hostNet;
          }
          net.commit({ silent: true });
        }
        return ok;
      },
      fix: () => {
        const core = net.device('core1');
        const acc2 = net.device('acc2');
        core.vlans[50] = { name: 'PARTNERS' };
        acc2.vlans[50] = { name: 'PARTNERS' };
        const svi = defaultInterfaceConfig('Vlan50', 'l3switch', false);
        svi.ip = { address: parseIp('10.10.50.1')!, prefix: 24 };
        svi.description = 'PARTNERS gateway';
        core.running.interfaces['Vlan50'] = svi;
        for (const p of plan) {
          const peer = net.peerOf(p.person.pcId, NIC);
          if (peer) net.device(peer.device).running.interfaces[peer.iface].switchport!.accessVlan = 50;
        }
        net.commit();
        reIp();
      },
    };
  },
};

export const TEMPLATES: TicketTemplate[] = [
  portShutdown,
  wrongVlan,
  cableUnplugged,
  nicDisabled,
  badCable,
  driverOutdated,
  newPcNoDriver,
  printerPort,
  printerVlanDown,
  trunkPruned,
  defaultRouteGone,
  fileServerSpeed,
  movedDesk,
  partnerVlan,
  apipaBlip,
  wrongGateway,
  staleDns,
  helperMissing,
  ...ACL_TEMPLATES,
  ...NAT_TEMPLATES,
  ...GUEST_TICKETS,
  ...ROUTING_TICKETS,
  ...SWITCHING_TICKETS,
  ...OPS_TICKETS,
  ...SECURITY_TICKETS,
  ...PHYSICAL_TICKETS,
];

export function rebuildDraft(env: Env, templateId: string, params: Params): TicketDraft {
  const t = TEMPLATES.find((x) => x.id === templateId);
  if (!t) throw new Error(`Unknown ticket template ${templateId}`);
  return t.build(env, params);
}
