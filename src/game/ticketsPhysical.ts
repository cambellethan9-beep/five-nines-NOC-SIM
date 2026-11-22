// Physical-layer tickets: a printer's cable worked loose, a broken print driver on one PC, and a patch cable that
// someone moved to the wrong switch port while tidying the closet.

import { dhcpRequest } from '../sim/dhcp';
import { LATEST_PRINT_DRIVER } from './physical';
import { FS01, INTERNET, NIC, freePeople, freePorts, person, reaches, variant, type TicketTemplate, type TemplateContext } from './ticketKit';

const PRINTERS = [
  { id: 'prn1', sw: 'acc1', ip: '10.10.30.21', floor: '1st' },
  { id: 'prn2', sw: 'acc2', ip: '10.10.30.22', floor: '2nd' },
];
const onFloor = (ctx: TemplateContext, sw: string) => freePeople(ctx).filter((p) => ctx.net.peerOf(p.pcId, NIC)?.device === sw);

const printerCable: TicketTemplate = {
  id: 'printer-cable',
  difficulty: 'easy',
  canStart: (ctx) => !ctx.activeTemplates.has('printer-cable') && !ctx.activeTemplates.has('printer-port') && PRINTERS.some((p) => ctx.net.linkAt(p.id, 'FastEthernet0')?.cable === 'ok' && onFloor(ctx, p.sw).length > 0),
  plan: (ctx) => {
    const pr = ctx.rng.pick(PRINTERS.filter((p) => ctx.net.linkAt(p.id, 'FastEthernet0')?.cable === 'ok' && onFloor(ctx, p.sw).length > 0));
    return { printer: pr.id, pcId: ctx.rng.pick(onFloor(ctx, pr.sw)).pcId, variant: ctx.rng.int(0, 1) };
  },
  build: (env, params) => {
    const net = env.net;
    const pr = PRINTERS.find((p) => p.id === params.printer)!;
    const p = person(env, params.pcId);
    const link = () => net.linkAt(pr.id, Object.keys(net.device(pr.id).hardware)[0])!;
    return {
      templateId: 'printer-cable',
      params,
      kind: 'incident',
      difficulty: 'easy',
      truePriority: 3,
      subject: `${pr.floor} floor printer offline`,
      description: variant(
        [
          `The ${pr.floor} floor copy room printer shows offline for everyone. The delivery guy was restocking paper behind it this morning.`,
          `Nobody on our floor can print. The printer's screen looks normal but our PCs say it's offline.`,
        ],
        params,
      ),
      reporter: p,
      pcs: [p.pcId],
      inject: () => {
        link().cable = 'unplugged';
        net.commit();
      },
      check: () => reaches(net, p.pcId, pr.ip),
      fix: () => {
        link().cable = 'ok';
        net.commit();
      },
      explain: `The network cable had been knocked half out of the back of the printer (not clicked in), so its switch port went down. ${pr.sw === 'acc1' ? 'CR-ACC1' : 'CR-ACC2'} Fa0/20 showed notconnect. Reseating the cable at the printer brought the link back.`,
      hint: 'Is the printer\'s switch port up? If not, the problem is somewhere between the port and the printer.',
    };
  },
};

const printDriver: TicketTemplate = {
  id: 'printer-driver',
  difficulty: 'easy',
  canStart: (ctx) => !ctx.activeTemplates.has('printer-driver') && freePeople(ctx).some((p) => ctx.net.device(p.pcId).printDriver?.ok !== false),
  plan: (ctx) => ({ pcId: ctx.rng.pick(freePeople(ctx).filter((p) => ctx.net.device(p.pcId).printDriver?.ok !== false)).pcId, variant: ctx.rng.int(0, 1) }),
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const pc = () => net.device(p.pcId);
    return {
      templateId: 'printer-driver',
      params,
      kind: 'incident',
      difficulty: 'easy',
      truePriority: 4,
      subject: "Can't print, only me",
      description: variant(
        [
          `Since the Windows update last night I get "Operation failed with error 0x0000011b" whenever I print. People around me can print fine.`,
          `My print jobs just vanish. Everyone else on the floor is printing. Internet and the S: drive work.`,
        ],
        params,
      ),
      reporter: p,
      pcs: [p.pcId],
      inject: () => {
        pc().printDriver = { version: '6.4.0', ok: false };
      },
      check: () => pc().printDriver?.ok === true && reaches(net, p.pcId, FS01),
      fix: () => {
        pc().printDriver = { version: LATEST_PRINT_DRIVER, ok: true };
      },
      explain: `A Windows update broke the old print driver (6.4.0) on ${p.pcId.toUpperCase()}. The network and the printer were fine (others printed). Reinstalling the current NetSmart Universal driver from Device Manager at the desk fixed it.`,
      hint: 'Only one person, everything else works, and the printer works for others. What on that PC sits between the user and the printer?',
    };
  },
};

const patchedWrong: TicketTemplate = {
  id: 'patched-wrong',
  difficulty: 'moderate',
  canStart: (ctx) => !['patched-wrong', 'moved-desk', 'rogue-device', 'rogue-dhcp'].some((t) => ctx.activeTemplates.has(t)) && (['acc1', 'acc2'] as const).some((sw) => freePorts(ctx.net, sw).length > 0 && onFloor(ctx, sw).length > 0),
  plan: (ctx) => {
    const sw = ctx.rng.pick((['acc1', 'acc2'] as const).filter((s) => freePorts(ctx.net, s).length > 0 && onFloor(ctx, s).length > 0));
    const p = ctx.rng.pick(onFloor(ctx, sw));
    return { pcId: p.pcId, sw, from: ctx.net.peerOf(p.pcId, NIC)!.iface, to: ctx.rng.pick(freePorts(ctx.net, sw)), variant: ctx.rng.int(0, 1) };
  },
  build: (env, params) => {
    const net = env.net;
    const p = person(env, params.pcId);
    const sw = String(params.sw);
    const from = String(params.from);
    const to = String(params.to);
    const short = (x: string) => x.replace('FastEthernet', 'Fa');
    return {
      templateId: 'patched-wrong',
      params,
      kind: 'incident',
      difficulty: 'moderate',
      truePriority: 3,
      subject: 'No network since the closet was cleaned up',
      description: variant(
        [
          `Facilities "tidied the cables" in the network closet this morning and since then my PC has no network. Nobody else seems affected.`,
          `My computer lost the network around 9. Someone was in the closet next to my desk with a label maker.`,
        ],
        params,
      ),
      reporter: p,
      pcs: [p.pcId],
      inject: () => {
        if (net.peerOf(p.pcId, NIC)?.iface !== from) return;
        net.disconnect(p.pcId, NIC);
        net.connect(p.pcId, NIC, sw, to);
        net.commit();
        dhcpRequest(net, p.pcId);
      },
      check: () => reaches(net, p.pcId, FS01, INTERNET),
      fix: () => {
        net.disconnect(p.pcId, NIC);
        net.connect(p.pcId, NIC, sw, from);
        net.commit();
        dhcpRequest(net, p.pcId);
      },
      explain: `While tidying, Facilities plugged the patch cable for desk ${p.desk} into ${sw === 'acc1' ? 'CR-ACC1' : 'CR-ACC2'} ${short(to)} instead of ${short(from)}. ${short(to)} was never configured (VLAN 1), so the PC got a 169.254 address. The label above ${short(from)} still said "Desk ${p.desk}" and that port was notconnect. Moving the cable back (or configuring ${short(to)} for VLAN 10) and renewing fixed it.`,
      hint: 'Find which switch port the PC is really on now (the MAC address table knows), and compare it with the labels on the switch.',
    };
  },
};

export const PHYSICAL_TICKETS: TicketTemplate[] = [printerCable, printDriver, patchedWrong];
