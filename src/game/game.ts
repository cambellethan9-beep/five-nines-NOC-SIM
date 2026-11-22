// Game state on top of the simulation: where the player is standing, console sessions,
// monitoring history, background activity and the documentation they inherited.

import { predecessorDocs, type Doc } from '../content/docs';
import { buildOffice, ZONES, type Office } from '../content/office';
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
import { RULES } from './scoring';
import { serviceHealth, SERVICES, type ServiceHealth } from './services';

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
  ambient: ReturnType<Ambient['exportState']>;
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
    this.queue = new TicketQueue(this.net, this.office, this.net.rng, () => this.shiftStart + SHIFT_MS);
    this.chat = new Chat(this.net, this.office, this.net.rng, () => this.health.perUser, undefined, () => {
      const open = this.queue.openTickets().filter((t) => !t.escalation && t.seniorAt === null);
      if (!open.length) return null;
      const t = [...open].sort((a, b) => a.priority - b.priority || a.openedAt - b.openedAt)[0];
      return { id: t.id, hint: t.draft.hint };
    });
    this.queue.onCoworkerMessage = (id, text) => this.chat.coworkerSay(id, text);
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
    this.shiftStart = save.shift.start;
    this.report = save.shift.report;
    this.upPairs = save.shift.upPairs;
    this.totalPairs = save.shift.totalPairs;
    this.drainAcc = save.shift.drainAcc;
    this.drainShift = save.shift.drainShift;
    this.healthyAcc = save.shift.healthyAcc ?? 0;
    this.healthyShift = save.shift.healthyShift ?? 0;
    this.lastDrainPost = save.shift.lastDrainPost;
    this.queue.importState(save.queue);
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
    return this.health.brokenPairs * RULES.drainPerUserMinute;
  }

  tick(ms: number): void {
    if (this.report) return;
    // Advance in sample-sized steps so a long jump (walking) still gets drained and checked.
    let left = ms;
    while (left > 0) {
      const step = Math.min(left, SAMPLE_MS);
      left -= step;
      this.net.advance(step);
      this.ambient.update();
      this.dhcp.update(this.net);
      if (this.started) {
        this.queue.update();
        this.checkServices(step);
        this.chat.update();
      }
      this.sample();
      if (this.started && this.shiftRemaining === 0) {
        this.endShift();
        return;
      }
    }
  }

  private checkServices(stepMs = 0): void {
    this.health = serviceHealth(this.net, this.office);
    const pairs = this.health.usersPresent * SERVICES.length;
    this.totalPairs += pairs * stepMs;
    this.upPairs += (pairs - this.health.brokenPairs) * stepMs;
    this.drainAcc += (this.health.brokenPairs * RULES.drainPerUserMinute * stepMs) / 60_000;
    if (this.healthy) this.healthyAcc += (RULES.healthyPointsPerSecond * stepMs) / 1000;
    if (this.net.time - this.lastDrainPost >= 60_000) {
      this.postAccrued();
      this.lastDrainPost = this.net.time;
    }
  }

  /** No broken services and no open incidents. Change requests don't count as problems. */
  get healthy(): boolean {
    return this.health.brokenPairs === 0 && !this.queue.openTickets().some((t) => t.draft.kind === 'incident');
  }

  /** Points per minute right now: positive while healthy, negative while services are down. */
  get pointsPerMinute(): number {
    if (this.health.brokenPairs > 0) return -this.drainPerMinute;
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
    this.postAccrued();
    const stats = this.shiftStats();
    const met = stats.slaCompliance >= stats.slaTarget && stats.availability >= stats.uptimeTarget;
    const bonus = met ? RULES.shiftBonus : -RULES.shiftPenalty;
    this.queue.addPoints(met ? 'Shift targets met' : 'Shift targets missed', bonus);
    this.report = { ...stats, points: stats.points + bonus, bonus, lifetimePoints: this.queue.lifetimePoints };
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
    return canReach(this.net, this.office.tutorial.pcId, parseIp('10.10.20.11')!);
  }

  /** Who is involved in a ticket, for the detail view. */
  ticketDevice(t: Ticket): Device {
    return this.net.device(t.draft.reporter.pcId);
  }
}
