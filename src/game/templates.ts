// The ticket library: each template breaks something real in the network (or asks for a change),
// knows how to check that it's actually fixed, and how a senior would fix it.
// True priority is hard-coded from real impact; the service desk's priority may differ.
//
// Templates are split into plan() (random choices, stored as plain params) and build() (turns params
// into the live ticket), so a ticket can be saved and rebuilt exactly.

import type { Office, Person } from '../content/office';
import { defaultInterfaceConfig } from '../sim/devices';
import { parseIp } from '../sim/ip';
import type { Network } from '../sim/network';
import type { Rng } from '../sim/rng';
import { canReach } from '../sim/routing';
import { CURRENT_NIC_DRIVER } from '../sim/types';
import type { Difficulty, Priority } from './scoring';

export type Params = Record<string, string | number | boolean>;

export interface TicketDraft {
  templateId: string;
  params: Params;
  kind: 'incident' | 'request';
  difficulty: Difficulty;
  truePriority: Priority;
  subject: string;
  description: string;
  reporter: Person;
  /** PCs involved; they won't fall asleep while the ticket is open. */
  pcs: string[];
  /** Breaks the network (incidents). Requests change nothing until done. */
  inject: () => void;
  /** Is it actually fixed / done? Checks the outcome, not which commands were used. */
  check: () => boolean;
  /** What a senior does when they take the ticket over. */
  fix: () => void;
  /** What was actually wrong and what fixed it (coworkers tell you this). */
  explain: string;
  /** A nudge in the right direction, without the answer. */
  hint: string;
}

export interface Env {
  net: Network;
  office: Office;
}

export interface TemplateContext extends Env {
  rng: Rng;
  /** PCs already involved in another open ticket. */
  busyPcs: Set<string>;
  /** Templates with a ticket currently open. */
  activeTemplates: Set<string>;
  /** Templates that have ever run (for one-time requests). */
  usedTemplates: Set<string>;
}

export interface TicketTemplate {
  id: string;
  difficulty: Difficulty;
  canStart: (ctx: TemplateContext) => boolean;
  plan: (ctx: TemplateContext) => Params;
  build: (env: Env, params: Params) => TicketDraft;
}

// ---- helpers ----------------------------------------------------------------------------

const FS01 = '10.10.20.11';
const INTERNET = '8.8.8.8';
const NIC = 'FastEthernet0';

/** Runs a check with the given PCs awake (a sleeping PC can't prove anything). */
function withAwake<T>(net: Network, pcIds: string[], fn: () => T): T {
  const asleep = pcIds.map((id) => net.device(id)).filter((d) => !d.powered);
  if (!asleep.length) return fn();
  for (const d of asleep) d.powered = true;
  net.commit({ silent: true });
  try {
    return fn();
  } finally {
    for (const d of asleep) d.powered = false;
    net.commit({ silent: true });
  }
}

function reaches(net: Network, pcId: string, ...targets: string[]): boolean {
  return withAwake(net, [pcId], () => targets.every((t) => canReach(net, pcId, parseIp(t)!)));
}

function person(env: Env, pcId: unknown): Person {
  const p = env.office.people.find((x) => x.pcId === pcId);
  if (!p) throw new Error(`No person at ${String(pcId)}`);
  return p;
}

function hasPort(net: Network, p: Person): boolean {
  return net.peerOf(p.pcId, NIC) !== null;
}

function freePeople(ctx: TemplateContext): Person[] {
  return ctx.office.people.filter((p) => !ctx.busyPcs.has(p.pcId) && hasPort(ctx.net, p));
}

function pickPerson(ctx: TemplateContext): Params {
  return { pcId: ctx.rng.pick(freePeople(ctx)).pcId, variant: ctx.rng.int(0, 2) };
}

/** "CR-ACC1 Fa0/7": the switch port a PC is patched into. */
function portLabel(net: Network, pcId: string): string {
  const peer = net.peerOf(pcId, NIC);
  if (!peer) return 'an unpatched port';
  return `${net.device(peer.device).running.hostname} ${peer.iface.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gi')}`;
}

function floorOf(net: Network, pcId: string): 'acc1' | 'acc2' {
  return net.peerOf(pcId, NIC)?.device === 'acc2' ? 'acc2' : 'acc1';
}

function variant(lines: string[], params: Params): string {
  return lines[Number(params.variant ?? 0) % lines.length];
}

/** Empty desks: unused access ports 11-19 with nothing plugged in. */
function freePorts(net: Network, swId: string): string[] {
  const ports: string[] = [];
  for (let i = 11; i <= 19; i++) {
    const name = `FastEthernet0/${i}`;
    if (!net.linkAt(swId, name)) ports.push(name);
  }
  return ports;
}

/** Builds a one-person incident where the user just needs FS01 and the internet back. */
function userIncident(
  env: Env,
  params: Params,
  spec: Omit<TicketDraft, 'params' | 'kind' | 'reporter' | 'pcs' | 'check' | 'templateId'> & { templateId: string },
): TicketDraft {
  const p = person(env, params.pcId);
  return {
    ...spec,
    params,
    kind: 'incident',
    reporter: p,
    pcs: [p.pcId],
    check: () => reaches(env.net, p.pcId, FS01, INTERNET),
  };
}

const userTicket = (id: string, difficulty: Difficulty, build: TicketTemplate['build']): TicketTemplate => ({
  id,
  difficulty,
  canStart: (ctx) => freePeople(ctx).length > 0,
  plan: pickPerson,
  build,
});

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
      explain: `The port at desk ${params.desk} (${String(params.to) === 'acc1' ? 'CR-ACC1' : 'CR-ACC2'} ${String(params.port).replace('FastEthernet', 'Fa')}) had never been configured, so it was still in VLAN 1. Put it in VLAN 10 as an access port.`,
      hint: 'New desk, new switch port. What VLAN is an unused port in by default?',
      description: `Hi! I moved to the empty desk ${params.desk} this morning to sit with my team. Plugged everything back in the same way but my PC can't connect to anything now.`,
      reporter: p,
      pcs: [p.pcId],
      inject: () => {
        net.disconnect(p.pcId, NIC);
        net.connect(p.pcId, NIC, sw.id, port);
        p.desk = String(params.desk);
        net.commit();
      },
      check: () => reaches(net, p.pcId, FS01, INTERNET),
      fix: () => {
        const ifc = sw.running.interfaces[port];
        ifc.switchport!.mode = 'access';
        ifc.switchport!.accessVlan = 10;
        ifc.shutdown = false;
        net.commit();
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
  canStart: (ctx) => !ctx.activeTemplates.has('default-route') && ctx.net.device('rtr1').running.staticRoutes.some((r) => r.prefix === 0),
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
  canStart: (ctx) => !ctx.activeTemplates.has('fs-speed') && freePeople(ctx).length > 0,
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
      explain: 'Created VLAN 50 (PARTNERS) on CR-CORE1 and CR-ACC2, gave CR-CORE1 a VLAN 50 interface at 10.10.50.1, and moved the partners\' two ports into VLAN 50.',
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
          return { pc, ip: pc.running.interfaces[NIC].ip, gw: pc.running.defaultGateway };
        });
        reIp();
        const ok = withAwake(net, plan.map((p) => p.person.pcId), () =>
          plan.every((p) => ['10.10.20.11', '10.10.20.12', INTERNET].every((t) => canReach(net, p.person.pcId, parseIp(t)!))),
        );
        if (!ok) {
          for (const b of before) {
            b.pc.running.interfaces[NIC].ip = b.ip;
            b.pc.running.defaultGateway = b.gw;
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
];

export function rebuildDraft(env: Env, templateId: string, params: Params): TicketDraft {
  const t = TEMPLATES.find((x) => x.id === templateId);
  if (!t) throw new Error(`Unknown ticket template ${templateId}`);
  return t.build(env, params);
}
