// Game state on top of the simulation: where the player is standing, console sessions,
// monitoring history, background activity and the documentation they inherited.

import { Breakage, type BreakageState } from './breakage';
import { replaceNic } from './desk';
import { Team, type TeamState } from './team';
import type { RunbookSettings } from './runbooks';
import { dhcpRequest } from '../sim/dhcp';
import { LATEST_PRINT_DRIVER, LATEST_PRINTER_FIRMWARE, type CableInHand } from './physical';
import { migratePlacement, PLACEMENT_RANK, placedRank, type PlacementState } from './placement';
import { Achievements, type AchievementState } from './achievements';
import { IncidentLog, type DeclaredIncident, type IncidentReview, type IncidentState } from './incidents';
import { updateArchives } from '../sim/backup';
import { updateQuietMode } from '../sim/hardening';
import { textToBlocks } from '../content/doctext';
import { predecessorDocs, type Doc } from '../content/docs';
import { buildOffice, NOC_PC_IP, SNMP_COMMUNITY, ZONES, type Office } from '../content/office';
import { snmpAnswers } from '../sim/mgmt';
import { Ambient } from '../sim/ambient';
import { DhcpWatcher } from '../sim/dhcp';
import { CliSession } from '../sim/cli/session';
import { HostShell, type ConsoleSession } from '../sim/host';
import { parseIp } from '../sim/ip';
import type { Network, NetworkState } from '../sim/network';
import { canReach } from '../sim/routing';
import { deviceCpu, interfaceRates } from '../sim/traffic';
import { isHostKind, type Device } from '../sim/types';
import { Chat, type ChatState } from './chat';
import { TicketQueue, type QueueState, type Ticket } from './queue';
import { pointsBar, RANKS, RULES, streakAfterMiss, streakBonus, type Priority } from './scoring';
import { reachService, serviceHealth, SERVICES, type ServiceHealth } from './services';

/** Walking to a different console costs this much game time. */
export const WALK_MS = 30_000;
export const SAMPLE_MS = 5_000;
const HISTORY = 120; // 10 minutes of samples
const PREROLL_MS = 15 * 60_000;
export const SHIFT_MS = 60 * 60_000;
export const SAVE_VERSION = 1;

export interface Note {
  id: string;
  title: string;
  body: string;
  /** Sim time of the last edit. */
  updated: number;
  /** Set when this note is used as a runbook: its triggers and whether employees may use it. */
  runbook?: RunbookSettings;
}

export interface SaveFile {
  version: number;
  savedAt: number;
  seed: string;
  net: NetworkState;
  people: Office['people'];
  docs: Doc[];
  notes: Note[];
  knownHosts: [string, string][];
  location: string;
  introPending?: boolean;
  debriefShown?: boolean;
  shift: {
    start: number;
    report: ShiftReport | null;
    upPairs: number;
    totalPairs: number;
    drainAcc: number;
    drainShift: number;
    healthyAcc?: number;
    healthyShift?: number;
    lastDrainPost: number;
  };
  queue: QueueState;
  incidents?: IncidentState;
  achievements?: AchievementState;
  placement?: { offered: boolean; state: PlacementState | null };
  cableInHand?: CableInHand | null;
  team?: TeamState;
  ambient: ReturnType<Ambient['exportState']>;
  breakage?: BreakageState;
  chat: ChatState;
}

export interface ShiftReport {
  shift: number;
  rankName: string;
  points: number;
  ticketsOpened: number;
  ticketsDue: number;
  ticketsInSla: number;
  slaCompliance: number;
  slaTarget: number;
  availability: number;
  uptimeTarget: number;
  bonus: number;
  drain: number;
  /** Points earned while the network was healthy. */
  healthy: number;
  lifetimePoints: number;
  /** Reliability streak after this shift, and what it paid (0 when the uptime target was missed). */
  streak?: number;
  streakBonus?: number;
  /** Promotion progress after this shift. */
  promotion?: { pointsPerShift: number; shifts: number; done: number; qualified: boolean; promotedTo?: string };
  /** Hardware that failed this shift, and running MTBF/MTTR in game ms. */
  hardware?: { failures: number; mtbf: number | null; mttr: number | null };
}

export interface Sample {
  t: number;
  cpu: number;
  inBps: number;
  outBps: number;
  ifaces: Record<string, { inBps: number; outBps: number }>;
}

export class Game {
  readonly office: Office;
  readonly net: Network;
  readonly ambient: Ambient;
  docs: Doc[];
  /** Device whose console the player is at. */
  location: string;
  readonly sessions = new Map<string, ConsoleSession>();
  readonly history = new Map<string, Sample[]>();
  private lastSample = -Infinity;
  /** Sim time when the current shift began (the office runs a while before you arrive). */
  shiftStart = Infinity;
  readonly queue: TicketQueue;
  /** Incidents the NOC declared itself. */
  readonly incidents = new IncidentLog();
  readonly achievements = new Achievements();
  /** Your team (the intern, for now). */
  readonly team = new Team();
  /** Hardware wearing out in real time. */
  readonly breakage: Breakage;
  /** The optional placement shift: offered once on a new game, until taken or declined. */
  placementOffered = true;
  placement: PlacementState | null = null;
  /** A patch cable you unplugged at a switch and are holding. */
  cableInHand: CableInHand | null = null;
  /** PCs ask DHCP for an address whenever their link comes up. */
  readonly dhcp = new DhcpWatcher();
  readonly chat: Chat;
  /** Latest service check. */
  health: ServiceHealth = { usersPresent: 0, down: {}, brokenPairs: 0, affectedUsers: 0, perUser: {} };
  /** End-of-shift report; while set, time is stopped. */
  report: ShiftReport | null = null;
  private upPairs = 0;
  private totalPairs = 0;
  private drainAcc = 0;
  private drainShift = 0;
  /** Points earned for a healthy network, not yet posted / posted this shift. */
  private healthyAcc = 0;
  private healthyShift = 0;
  private lastDrainPost = 0;
  /** First-day intro still to show (time is paused until it's dismissed). */
  introPending = true;
  /** The one-time debrief after the tutorial ticket closes. */
  debriefShown = false;
  /** Your own notes (the Notebook section of Docs). */
  notes: Note[] = [];
  /** The NOC PC's ~/.ssh/known_hosts. */
  readonly knownHosts = new Map<string, string>();
  readonly seed: string;

  constructor(seed: string = 'cedar-ridge', save?: SaveFile) {
    this.seed = seed;
    this.office = buildOffice(seed);
    this.net = this.office.net;
    this.location = this.office.home;
    this.breakage = new Breakage(seed);
    this.queue = new TicketQueue(this.net, this.office, this.net.rng, () => this.shiftStart + SHIFT_MS);
    this.chat = new Chat(this.net, this.office, this.net.rng, () => this.health.perUser, undefined, () => {
      const open = this.queue.openTickets().filter((t) => !t.escalation && t.seniorAt === null);
      if (!open.length) return null;
      const t = [...open].sort((a, b) => a.priority - b.priority || a.openedAt - b.openedAt)[0];
      return { id: t.id, hint: t.draft.hint };
    }, () => new Set(this.waitingUsers));
    this.queue.onCoworkerMessage = (id, text) => this.chat.coworkerSay(id, text);
    this.team.onMessage = (id, text) => this.chat.employeeSay(id, text);
    this.chat.employeeName = (id) => this.team.find(id)?.name;
    this.chat.onEmployeeMessage = (id, text) => {
      const e = this.team.find(id);
      return e ? this.team.chatReply(this, e, text) : null;
    };
    // A senior who fixes something renews any PC that gave up on DHCP while it was broken.
    this.queue.onSeniorCleanup = () => {
      for (const d of this.net.devices.values()) {
        if (d.hostNet?.dhcp && d.powered && (d.hostNet.apipa || !d.hostNet.lease)) dhcpRequest(this.net, d.id);
      }
    };
    this.queue.affectedNow = () => {
      this.health = serviceHealth(this.net, this.office);
      return this.health.affectedUsers;
    };
    this.queue.onOpened = (t, faultAt) => {
      if (t.draft.kind !== 'incident') return;
      const parent = this.incidents.autoParent(faultAt);
      if (!parent) return;
      const now = this.net.time;
      this.incidents.link(parent.id, t.id, now, this.queue.isOpen(t) ? `${t.draft.reporter.name} reported it` : 'fixed before anyone reported it');
      if (this.queue.isOpen(t)) {
        t.activity.push({ t: now, who: 'system', text: `Linked by the service desk to ${parent.id} (${parent.title}), which the NOC already declared.` });
        this.queue.acknowledge(t.id);
      }
    };
    this.ambient = new Ambient(this.net, () => {
      const busy = this.queue.busyPcs();
      busy.add(this.office.tutorial.pcId);
      return busy;
    });
    this.docs = predecessorDocs(this.office);
    this.office.hostOptions.noc = { ...this.office.hostOptions.noc, knownHosts: this.knownHosts };
    if (save) {
      this.load(save);
      return;
    }
    for (const d of this.net.devices.values()) {
      if (d.managed && !isHostKind(d.kind)) this.net.log(d.id, '%SYS-5-RESTART: System restarted --');
    }
    // Let the office run for a while so logs and graphs have history when the shift starts.
    this.dhcp.baseline(this.net);
    for (let t = 0; t < PREROLL_MS; t += SAMPLE_MS) this.tick(SAMPLE_MS);
    this.beginShift();
    this.queue.openTutorial();
  }

  // ---- notebook ----

  // ---- the physical layer (you have to be standing there) ----

  /** Pulls the patch cable out of a switch port. You keep holding it. */
  unplugPort(sw: string, port: string): string {
    if (this.location !== sw) return 'You have to be at the switch to touch its cables.';
    if (this.cableInHand) return 'Your hands are full: plug in the cable you are holding first.';
    const peer = this.net.peerOf(sw, port);
    if (!peer) return 'Nothing is plugged into that port.';
    this.cableInHand = { device: peer.device, iface: peer.iface, fromDevice: sw, fromPort: port };
    this.net.disconnect(sw, port);
    this.net.commit();
    this.tick(5000);
    return `Unplugged the cable from ${port.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gi')}.`;
  }

  /** Plugs the cable you're holding into a free port. */
  plugPort(sw: string, port: string): string {
    if (this.location !== sw) return 'You have to be at the switch.';
    const c = this.cableInHand;
    if (!c) return "You aren't holding a cable.";
    if (this.net.linkAt(sw, port)) return 'That port already has a cable in it.';
    this.net.connect(c.device, c.iface, sw, port);
    this.cableInHand = null;
    this.net.commit();
    this.tick(5000);
    return `Plugged the cable into ${port.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gi')}.`;
  }

  setPortLabel(sw: string, port: string, text: string): void {
    const d = this.net.device(sw);
    const labels = (d.portLabels ??= {});
    if (text.trim()) labels[port] = text.trim().slice(0, 24);
    else delete labels[port];
  }

  /** Printer front panel: reseat the network cable at the printer. */
  reseatPrinterCable(id: string): string {
    if (this.location !== id) return 'You have to be at the printer.';
    const nic = Object.keys(this.net.device(id).hardware)[0];
    const link = this.net.linkAt(id, nic);
    if (!link) return 'There is no network cable in the printer.';
    if (link.cable === 'unplugged') {
      link.cable = 'ok';
      this.net.commit();
      return 'Pushed the network cable back into the printer. Click. The link light comes on.';
    }
    if (link.cable === 'cut') return 'Reseated it. The link light stays off: the cable itself is damaged.';
    return 'The cable was already seated. Link light is on.';
  }

  /** Printer front panel: install the latest firmware from the USB stick in your bag (the printer reboots). */
  updatePrinterFirmware(id: string): string {
    if (this.location !== id) return 'You have to be at the printer.';
    const d = this.net.device(id);
    if (d.firmware === LATEST_PRINTER_FIRMWARE) return `Firmware ${d.firmware} is already the latest.`;
    d.firmware = LATEST_PRINTER_FIRMWARE;
    d.bootingUntil = this.net.time + 120_000;
    this.net.commit();
    return `Installing firmware ${LATEST_PRINTER_FIRMWARE}. The printer restarts and is offline for about 2 minutes.`;
  }

  /** At a PC: swap in a spare network card. */
  replaceNicAt(pcId: string): string {
    if (this.location !== pcId) return 'You have to be at the PC.';
    const msg = replaceNic(this.net, this.net.device(pcId));
    this.tick(10 * 60_000);
    return msg;
  }

  /** At a switch: swap the patch cable in this port for a new one. */
  replaceCableAt(sw: string, port: string): string {
    if (this.location !== sw) return 'You have to be at the switch.';
    const link = this.net.linkAt(sw, port);
    if (!link) return 'There is no cable in that port.';
    const was = link.cable;
    link.cable = 'ok';
    this.net.commit();
    this.tick(2 * 60_000);
    return was === 'cut' ? 'Swapped in a new patch cable. The link light comes on.' : 'Swapped in a new patch cable. Nothing changed: the old one was fine.';
  }

  /** At a PC: reinstall the office printer driver. */
  updatePrintDriver(pcId: string): string {
    if (this.location !== pcId) return 'You have to be at the PC.';
    const d = this.net.device(pcId);
    d.printDriver = { version: LATEST_PRINT_DRIVER, ok: true };
    this.tick(60_000);
    return `Installed print driver ${LATEST_PRINT_DRIVER}. Test page printed.`;
  }

  /** Real time passing while the game runs (training counts in real time). */
  realTick(ms: number): void {
    this.team.tickReal(ms, this.net.time);
  }

  /** Turns a note into a runbook (or back). */
  setRunbook(noteId: string, settings: RunbookSettings | null): void {
    const n = this.notes.find((x) => x.id === noteId);
    if (!n) return;
    if (settings) n.runbook = settings;
    else delete n.runbook;
  }

  // ---- placement shift ----

  /**
   * Starts the placement test: an ordinary shift with a Network Engineer's ticket mix and limits, exactly like a
   * regular shift (escalation and hints included). Owen takes Priya's ticket so the test starts clean.
   */
  startPlacement(): void {
    if (!this.placementOffered || this.placement) return;
    this.placementOffered = false;
    this.queue.closeAllBySenior("Took care of this one so you can do the placement shift.");
    this.debriefShown = true;
    this.placement = { active: true, done: false, acknowledged: false, score: null, placedRank: null, lifetimeBefore: this.queue.lifetimePoints };
    this.queue.rankIndex = PLACEMENT_RANK;
    this.beginShift();
  }

  declinePlacement(): void {
    this.placementOffered = false;
  }

  /** The placement shift is over: score it, have Owen tidy up what's left, and put career points back. */
  private endPlacement(): void {
    this.breakage.stopClock();
    const p = this.placement!;
    this.queue.settleNotices();
    this.postAccrued();
    const stats = this.shiftStats();
    const met = stats.slaCompliance >= stats.slaTarget;
    const score = stats.points + (met ? RULES.shiftBonus : -RULES.shiftPenalty);
    const shiftTickets = this.queue.tickets.filter((t) => t.shift === this.queue.shift && t.draft.templateId !== 'port-shutdown');
    p.opened = shiftTickets.length;
    p.resolved = shiftTickets.filter((t) => t.status === 'resolved' && !t.resolvedBy).length;
    p.score = score;
    p.placedRank = placedRank(score);
    p.active = false;
    p.done = true;
    this.queue.closeAllBySenior('Wrapped this up after your placement shift.');
    this.queue.lifetimePoints = p.lifetimeBefore;
    this.queue.rankIndex = p.placedRank;
    this.queue.streak = 0;
    this.queue.qualifyingShifts = 0;
    this.achievements.state.placedRank = p.placedRank;
  }

  /** After the placement results: start the first real shift at the rank it gave you. */
  finishPlacement(): void {
    const p = this.placement;
    if (!p?.done || p.acknowledged) return;
    p.acknowledged = true;
    this.beginShift();
  }

  /** The placement shift is running. */
  get inPlacement(): boolean {
    return !!this.placement?.active;
  }

  /** Placement results are waiting to be read (time is stopped). */
  get placementResultsDue(): boolean {
    return !!this.placement?.done && !this.placement.acknowledged;
  }

  // ---- declared incidents ----

  declareIncident(title: string, severity: Priority, source?: string): DeclaredIncident {
    return this.incidents.declare(title, severity, this.net.time, source);
  }

  /** Links a ticket to an incident by hand (acknowledging it, since the NOC is on it). */
  linkTicket(incidentId: string, ticketId: string): void {
    const t = this.queue.find(ticketId);
    this.incidents.link(incidentId, ticketId, this.net.time, 'linked by you');
    if (this.queue.isOpen(t)) {
      t.activity.push({ t: this.net.time, who: 'you', text: `Linked to ${incidentId}.` });
      this.queue.acknowledge(t.id);
    }
  }

  /**
   * Resolves an incident with its post-incident review. Optionally resolves every open linked ticket too (each is
   * checked against the real network like any resolve) and writes the review into the notebook.
   */
  resolveIncident(id: string, review: IncidentReview, opts: { closeLinked: boolean; toNotebook: boolean }): { ticket: string; ok: boolean; message: string }[] {
    const inc = this.incidents.find(id);
    if (!inc) return [];
    const results: { ticket: string; ok: boolean; message: string }[] = [];
    if (opts.closeLinked) {
      for (const tid of inc.linked) {
        const t = this.queue.find(tid);
        if (!this.queue.isOpen(t) || t.status === 'escalated') continue;
        const r = this.queue.resolve(tid, `Resolved with ${id}: ${review.fix}`);
        results.push({ ticket: tid, ok: r.ok, message: r.message });
      }
    }
    this.incidents.resolve(id, this.net.time, review);
    if (opts.toNotebook) {
      const note = this.addNote();
      const lines = [
        `# Summary`,
        `- ${inc.title} (P${inc.severity})`,
        `- Declared ${this.net.formatLogTime(inc.declaredAt).slice(1, -4)}, resolved ${this.net.formatLogTime(this.net.time).slice(1, -4)}`,
        inc.linked.length ? `- Linked tickets: ${inc.linked.join(', ')}` : '- No user tickets linked',
        '',
        '# Root cause',
        review.cause || '-',
        '',
        '# Fix',
        review.fix || '-',
        '',
        '# Prevention',
        review.prevention || '-',
        '',
        '# Timeline',
        ...inc.timeline.map((e) => `- ${this.net.formatLogTime(e.t).slice(-12, -4)} ${e.text}`),
      ];
      this.updateNote(note.id, `${inc.id} review: ${inc.title}`, lines.join('\n'));
    }
    return results;
  }

  addNote(): Note {
    const note: Note = { id: `n${Date.now().toString(36)}${this.notes.length}`, title: 'Untitled note', body: '', updated: this.net.time };
    this.notes.unshift(note);
    return note;
  }

  updateNote(id: string, title: string, body: string): void {
    const n = this.notes.find((x) => x.id === id);
    if (!n) return;
    n.title = title.trim() || 'Untitled note';
    n.body = body;
    n.updated = this.net.time;
  }

  deleteNote(id: string): void {
    this.notes = this.notes.filter((n) => n.id !== id);
  }

  /** Edits an inherited doc in place (keeping the predecessor's version so it can be reverted). */
  updateDoc(id: string, text: string): void {
    const doc = this.docs.find((d) => d.id === id);
    if (!doc) return;
    doc.original ??= doc.blocks;
    doc.blocks = textToBlocks(text);
    doc.editedAt = this.net.time;
  }

  revertDoc(id: string): void {
    const doc = this.docs.find((d) => d.id === id);
    if (!doc?.original) return;
    doc.blocks = doc.original;
    delete doc.original;
    delete doc.editedAt;
  }

  // ---- saving ----

  toSave(): SaveFile {
    return {
      version: SAVE_VERSION,
      savedAt: Date.now(),
      seed: this.seed,
      net: this.net.exportState(),
      people: structuredClone(this.office.people),
      docs: this.docs,
      notes: this.notes,
      knownHosts: [...this.knownHosts.entries()],
      location: this.location,
      introPending: this.introPending,
      debriefShown: this.debriefShown,
      shift: {
        start: this.shiftStart,
        report: this.report,
        upPairs: this.upPairs,
        totalPairs: this.totalPairs,
        drainAcc: this.drainAcc,
        drainShift: this.drainShift,
        healthyAcc: this.healthyAcc,
        healthyShift: this.healthyShift,
        lastDrainPost: this.lastDrainPost,
      },
      queue: this.queue.exportState(),
      incidents: this.incidents.exportState(),
      achievements: this.achievements.exportState(),
      placement: { offered: this.placementOffered, state: this.placement },
      cableInHand: this.cableInHand,
      team: this.team.exportState(),
      breakage: this.breakage.exportState(),
      ambient: this.ambient.exportState(),
      chat: structuredClone(this.chat.state),
    };
  }

  private load(save: SaveFile): void {
    this.net.importState(save.net);
    this.office.people.splice(0, this.office.people.length, ...save.people);
    this.docs = save.docs;
    this.notes = save.notes;
    for (const [k, v] of save.knownHosts) this.knownHosts.set(k, v);
    this.location = save.location;
    this.introPending = save.introPending ?? false;
    this.debriefShown = save.debriefShown ?? true;
    // JSON turns Infinity (shift not started, during the placement test) into null.
    this.shiftStart = save.shift.start ?? Infinity;
    this.report = save.shift.report;
    this.upPairs = save.shift.upPairs;
    this.totalPairs = save.shift.totalPairs;
    this.drainAcc = save.shift.drainAcc;
    this.drainShift = save.shift.drainShift;
    this.healthyAcc = save.shift.healthyAcc ?? 0;
    this.healthyShift = save.shift.healthyShift ?? 0;
    this.lastDrainPost = save.shift.lastDrainPost;
    this.queue.importState(save.queue);
    this.incidents.importState(save.incidents);
    this.achievements.importState(save.achievements);
    this.achievements.fresh = [];
    this.placementOffered = save.placement?.offered ?? false;
    this.cableInHand = save.cableInHand ?? null;
    this.team.importState(save.team);
    this.breakage.importState(save.breakage);
    this.placement = migratePlacement(save.placement?.state);
    this.ambient.importState(save.ambient);
    this.chat.state = save.chat;
    this.dhcp.baseline(this.net);
    this.health = serviceHealth(this.net, this.office);
  }

  private beginShift(): void {
    this.shiftStart = this.net.time;
    this.lastDrainPost = this.net.time;
    this.queue.scheduleFromNow();
    this.upPairs = 0;
    this.totalPairs = 0;
    this.drainAcc = 0;
    this.drainShift = 0;
    this.healthyAcc = 0;
    this.healthyShift = 0;
    this.checkServices();
  }

  get started(): boolean {
    return this.net.time >= this.shiftStart;
  }

  /** Time since the current shift started. */
  get shiftTime(): number {
    return Math.max(0, this.net.time - this.shiftStart);
  }

  get shiftRemaining(): number {
    return Math.max(0, this.shiftStart + SHIFT_MS - this.net.time);
  }

  /** Points lost per minute right now to services being down. */
  get drainPerMinute(): number {
    return (this.health.brokenPairs + this.waitingUsers.length) * RULES.drainPerUserMinute;
  }

  /** People whose problem is fixed but who haven't been told: they're still not working. */
  get waitingUsers(): string[] {
    return [...new Set(this.queue.awaitingNotice().map((t) => t.draft.reporter.pcId))];
  }

  /** Tells the user their problem is fixed: a direct message, or an announcement to the whole office. */
  notifyUser(ticketId: string, how: 'direct' | 'everyone'): string | null {
    const t = this.queue.find(ticketId);
    const err = this.queue.notify(ticketId, how);
    if (err) return err;
    const first = t.draft.reporter.name.split(' ')[0];
    const text =
      how === 'direct'
        ? `Hi ${first}, ${t.id} is fixed: everything should be working again, so you can carry on. Let me know if anything still looks off.`
        : `All: the problem from earlier (${t.draft.subject.toLowerCase()}) is fixed and everything is working again. Thanks for your patience. Tell us if anything still looks off.`;
    this.chat.notifyFixed(t.draft.reporter.pcId, text, how);
    return null;
  }

  tick(ms: number): void {
    if (this.report || this.placementResultsDue) return;
    // Advance in sample-sized steps so a long jump (walking) still gets drained and checked.
    let left = ms;
    while (left > 0) {
      const step = Math.min(left, SAMPLE_MS);
      left -= step;
      this.net.advance(step);
      this.ambient.update();
      this.dhcp.update(this.net);
      this.net.recoverErrDisabled();
      updateQuietMode(this.net);
      updateArchives(this.net);
      if (this.started) {
        this.breakage.update(this.net, this.queue, this.queue.shift);
        this.queue.update();
        this.team.update(this);
        this.checkServices(step);
        this.chat.update();
      }
      this.sample();
      if (this.started && this.shiftRemaining === 0 && this.inPlacement) {
        this.endPlacement();
        this.achievements.evaluate(this);
        return;
      }
      if (this.started && this.shiftRemaining === 0) {
        this.endShift();
        this.achievements.evaluate(this);
        return;
      }
    }
    this.achievements.evaluate(this);
  }

  private checkServices(stepMs = 0): void {
    this.health = serviceHealth(this.net, this.office);
    const pairs = this.health.usersPresent * SERVICES.length;
    this.totalPairs += pairs * stepMs;
    this.upPairs += (pairs - this.health.brokenPairs) * stepMs;
    // People who were fixed but never told are still idle, so they cost the same as being broken.
    this.drainAcc += ((this.health.brokenPairs + this.waitingUsers.length) * RULES.drainPerUserMinute * stepMs) / 60_000;
    if (this.healthy) this.healthyAcc += (RULES.healthyPointsPerSecond * stepMs) / 1000;
    if (this.net.time - this.lastDrainPost >= 60_000) {
      this.postAccrued();
      this.lastDrainPost = this.net.time;
    }
  }

  /** No broken services and no open incidents. Change requests don't count as problems. */
  get healthy(): boolean {
    return this.health.brokenPairs === 0 && this.waitingUsers.length === 0 && !this.queue.openTickets().some((t) => t.draft.kind === 'incident');
  }

  /** Points per minute right now: positive while healthy, negative while services are down. */
  get pointsPerMinute(): number {
    if (this.drainPerMinute > 0) return -this.drainPerMinute;
    return this.healthy ? RULES.healthyPointsPerSecond * 60 : 0;
  }

  /** Moves whole points from the accumulators into the score. */
  private postAccrued(): void {
    if (this.drainAcc >= 1) {
      const pts = Math.floor(this.drainAcc);
      this.queue.addPoints('Service downtime', -pts);
      this.drainShift += pts;
      this.drainAcc -= pts;
    }
    if (this.healthyAcc >= 1) {
      const pts = Math.floor(this.healthyAcc);
      this.queue.addPoints('Healthy network', pts);
      this.healthyShift += pts;
      this.healthyAcc -= pts;
    }
  }

  /** Current shift's numbers (also used live in the UI). */
  shiftStats(): Omit<ShiftReport, 'bonus' | 'lifetimePoints'> {
    const q = this.queue;
    const rank = q.rank;
    const mine = q.tickets.filter((t) => t.shift === q.shift);
    const due = mine.filter((t) => t.status === 'resolved' || t.status === 'senior-resolved' || t.breached);
    const inSla = due.filter((t) => t.status === 'resolved' && !t.breached);
    const points =
      q.events.filter((e) => e.t >= this.shiftStart).reduce((s, e) => s + e.points, 0) - Math.floor(this.drainAcc) + Math.floor(this.healthyAcc);
    return {
      shift: q.shift,
      rankName: rank.name,
      points,
      ticketsOpened: mine.length,
      ticketsDue: due.length,
      ticketsInSla: inSla.length,
      slaCompliance: due.length ? inSla.length / due.length : 1,
      slaTarget: rank.slaTarget,
      availability: this.totalPairs ? this.upPairs / this.totalPairs : 1,
      uptimeTarget: rank.uptimeTarget,
      drain: this.drainShift + Math.floor(this.drainAcc),
      healthy: this.healthyShift + Math.floor(this.healthyAcc),
    };
  }

  private endShift(): void {
    this.breakage.stopClock();
    this.queue.settleNotices();
    this.team.endShift(this, this.net.rng);
    this.postAccrued();
    const stats = this.shiftStats();
    // Points are what count. Downtime already drains points while it lasts, so missing the uptime target adds no
    // extra penalty; the shift bonus rides on tickets resolved within SLA.
    const met = stats.slaCompliance >= stats.slaTarget;
    const q = this.queue;
    const rank = q.rank;
    const bonus = met ? RULES.shiftBonus : -RULES.shiftPenalty;
    q.addPoints(met ? 'Shift targets met' : 'Shift targets missed', bonus);
    // Reliability streak: reaching the points bar shift after shift pays more each time.
    let reliability = 0;
    if (stats.points + bonus >= pointsBar(q.rankIndex)) {
      q.streak++;
      reliability = streakBonus(q.streak, stats.uptimeTarget);
      q.addPoints(`Reliability streak (${q.streak} in a row)`, reliability);
    } else {
      q.streak = streakAfterMiss(q.streak);
    }
    const points = stats.points + bonus + reliability;
    // Promotion: the threshold every shift, in a row. Miss once and the count starts over.
    let promotion: ShiftReport['promotion'];
    if (rank.promotion) {
      const qualified = points >= rank.promotion.pointsPerShift;
      q.qualifyingShifts = qualified ? q.qualifyingShifts + 1 : 0;
      promotion = { ...rank.promotion, done: q.qualifyingShifts, qualified };
      if (q.qualifyingShifts >= rank.promotion.shifts && q.rankIndex < RANKS.length - 1) {
        q.rankIndex++;
        q.qualifyingShifts = 0;
        promotion.promotedTo = q.rank.name;
      }
    }
    const hw = this.breakage.stats();
    const hardware = { failures: this.breakage.log.filter((b) => b.shift === q.shift).length, mtbf: hw.mtbf, mttr: hw.mttr };
    this.report = { ...stats, points, bonus, lifetimePoints: q.lifetimePoints, streak: q.streak, streakBonus: reliability, promotion, hardware };
  }

  /** Starts the next shift on the same network. Open tickets carry over. */
  startNextShift(): void {
    this.report = null;
    this.queue.shift++;
    for (const t of this.queue.openTickets()) t.shift = this.queue.shift;
    this.beginShift();
  }

  tickets(): Ticket[] {
    return this.queue.tickets;
  }

  session(deviceId: string): ConsoleSession {
    let s = this.sessions.get(deviceId);
    if (!s) {
      const device = this.net.device(deviceId);
      s = isHostKind(device.kind) ? new HostShell(this.net, deviceId, this.office.hostOptions[deviceId]) : new CliSession(this.net, deviceId);
      this.sessions.set(deviceId, s);
    }
    return s;
  }

  canConsole(device: Device): boolean {
    return device.managed;
  }

  /** Walks to a device's console. Returns false if already there or not allowed. */
  walkTo(deviceId: string): boolean {
    if (deviceId === this.location || !this.canConsole(this.net.device(deviceId))) return false;
    this.location = deviceId;
    this.tick(WALK_MS);
    return true;
  }

  placeName(deviceId: string): string {
    if (deviceId === this.office.home) return 'your desk';
    const zone = ZONES.find((z) => z.id === this.office.layout[deviceId]?.zone);
    const device = this.net.device(deviceId);
    if (device.kind === 'pc' || device.kind === 'printer') return `${device.running.hostname} (${zone?.label ?? 'office'})`;
    return zone?.label.toLowerCase() ?? 'the closet';
  }

  /** IP the NOC monitors this device on, if any. */
  monitorIp(device: Device): number | null {
    for (const ifc of Object.values(device.running.interfaces)) {
      if (ifc.ip && !ifc.switchport) return ifc.ip.address;
    }
    return null;
  }

  /** Does the NOC's SNMP poller get answers from this device? (Hosts are watched by ping only.) */
  snmpOk(device: Device): boolean {
    return this.net.isOnline(device) && snmpAnswers(this.net, device, { ip: parseIp(NOC_PC_IP)!, community: SNMP_COMMUNITY });
  }

  /** Whether the NOC's monitoring would show this device as up (ping from the NOC PC). */
  reachable(device: Device): boolean {
    if (device.id === this.office.home) return this.net.isOnline(device);
    const ip = this.mgmtIp(device);
    return ip !== null && this.net.isOnline(device) && canReach(this.net, this.office.home, ip);
  }

  mgmtIp(device: Device): number | null {
    // Prefer the documented management address for network gear.
    const documented: Record<string, string> = { rtr1: '10.0.0.1', core1: '10.10.99.1', acc1: '10.10.99.11', acc2: '10.10.99.12' };
    if (documented[device.id]) return parseIp(documented[device.id]);
    return this.monitorIp(device);
  }

  /** Devices the NOC watches: everything managed except staff workstations. */
  monitored(): Device[] {
    return [...this.net.devices.values()].filter((d) => d.managed && !d.id.startsWith('ws'));
  }

  configUnsaved(device: Device): boolean {
    return !device.startup || JSON.stringify(device.startup) !== JSON.stringify(device.running);
  }

  private sample(): void {
    if (this.lastSample === -Infinity) this.lastSample = this.net.time - SAMPLE_MS;
    while (this.lastSample + SAMPLE_MS <= this.net.time) {
      this.lastSample += SAMPLE_MS;
      for (const device of this.monitored()) {
        const ifaces: Sample['ifaces'] = {};
        let inBps = 0;
        let outBps = 0;
        for (const name of Object.keys(device.hardware)) {
          const r = interfaceRates(this.net, device.id, name, this.lastSample);
          ifaces[name] = r;
          inBps += r.inBps;
          outBps += r.outBps;
        }
        const list = this.history.get(device.id) ?? [];
        list.push({ t: this.lastSample, cpu: deviceCpu(this.net, device, this.lastSample), inBps, outBps, ifaces });
        if (list.length > HISTORY) list.shift();
        this.history.set(device.id, list);
      }
    }
  }

  /**
   * Renames a device from the map. Like pushing `hostname X` over SSH: it changes the running
   * config only, so it needs `write memory` to survive a reboot. Returns an error message or null.
   */
  rename(deviceId: string, name: string): string | null {
    const device = this.net.device(deviceId);
    if (!device.managed) return "That device belongs to your ISP. You can't rename it.";
    if (!/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(name)) {
      return 'Hostnames start with a letter and use only letters, numbers and hyphens (max 63).';
    }
    if (!this.net.isOnline(device)) return `${device.running.hostname} is offline.`;
    device.running.hostname = name;
    if (!isHostKind(device.kind)) this.net.log(device.id, '%SYS-5-CONFIG_I: Configured from console by nocadmin on vty0 (10.10.99.50)');
    return null;
  }

  /** True once the tutorial ticket has been closed (by you or a senior) and the debrief hasn't been shown. */
  get debriefDue(): boolean {
    if (this.debriefShown) return false;
    const t = this.queue.tickets.find((x) => x.id === 'INC-1001');
    return !!t && (t.status === 'resolved' || t.status === 'senior-resolved');
  }

  tutorialSolved(): boolean {
    return reachService(this.net, this.office.tutorial.pcId, '10.10.20.11');
  }

  /** Who is involved in a ticket, for the detail view. */
  ticketDevice(t: Ticket): Device {
    return this.net.device(t.draft.reporter.pcId);
  }
}
