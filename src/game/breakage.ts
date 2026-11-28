// Real-time hardware breakage: things wear out on their own, at a realistic rate, whatever else is going on.
// Most of it is patch cables (desk cables most of all, then uplinks, server and printer cables), now and then a
// PC's network card, and very rarely a switch port. The rate scales with how many links the network has, so a
// small office sees a failure every week or two of shifts; a big network sees them all the time.
// Mean time between failures (MTBF) and mean time to repair (MTTR) are tracked from what really happened.

import type { Network } from '../sim/network';
import { Rng } from '../sim/rng';
import { faultById, type Site } from './faults';
import { planHardware } from './generator';
import type { TicketQueue } from './queue';

const SHIFT_MS = 60 * 60_000;
const MIN = 60_000;

/** Expected failures per cabled link per shift. The office has ~30 links, so about 0.15 a shift. */
export const FAILURES_PER_LINK_SHIFT = 0.005;

/** What fails, and how often, when something does. */
export const BREAKAGE_MIX: { fault: string; weight: number; what: string }[] = [
  { fault: 'cable-bad', weight: 0.7, what: 'desk patch cable' },
  { fault: 'infra-cable', weight: 0.2, what: 'uplink, server or printer cable' },
  { fault: 'nic-dead', weight: 0.07, what: 'PC network card' },
  { fault: 'port-dead', weight: 0.03, what: 'switch port' },
];

export interface Breakdown {
  id: number;
  fault: string;
  site: Site;
  at: number;
  fixedAt: number | null;
  shift: number;
}

export interface BreakageState {
  nextAt: number | null;
  seq: number;
  log: Breakdown[];
  /** Game time the clock has been running (for MTBF). */
  runMs: number;
  rng?: number;
}

/** Links that can wear out: everything cabled inside the office (not the ISP side). */
export function wearingLinks(net: Network): number {
  return net.links.filter((l) => ![l.a.device, l.b.device].some((d) => d === 'isp' || d === 'internet')).length;
}

export class Breakage {
  nextAt: number | null = null;
  seq = 1;
  readonly log: Breakdown[] = [];
  runMs = 0;
  private lastT: number | null = null;
  private nextCheck = 0;
  /** Its own dice, so hardware failures don't shift every other random event in the game. */
  private readonly rng: Rng;

  constructor(seed: string) {
    this.rng = new Rng(`${seed}:breakage`);
  }

  /** Failures per shift for this network. */
  rate(net: Network): number {
    return FAILURES_PER_LINK_SHIFT * wearingLinks(net);
  }

  private schedule(net: Network): void {
    const rng = this.rng;
    // Failures are random and independent: exponential gaps between them (a Poisson process).
    const gap = (-Math.log(1 - rng.next()) / this.rate(net)) * SHIFT_MS;
    this.nextAt = net.time + Math.max(MIN, gap);
  }

  /** Called every tick during a shift. Returns the breakdown that just happened, if any. */
  update(net: Network, queue: TicketQueue, shift: number): Breakdown | null {
    const rng = this.rng;
    const now = net.time;
    if (this.lastT !== null && now > this.lastT) this.runMs += now - this.lastT;
    this.lastT = now;
    if (now >= this.nextCheck) {
      this.nextCheck = now + 15_000;
      for (const b of this.log) if (b.fixedAt === null && faultById(b.fault).repaired?.(net, b.site)) b.fixedAt = now;
    }
    if (this.nextAt === null) this.schedule(net);
    if (now < this.nextAt!) return null;
    const ctx = queue.context();
    // Pick what fails; if that can't happen anywhere right now (no free port, say), pick again from the rest.
    let choices = [...BREAKAGE_MIX];
    let pick = choices[0];
    let params = null;
    while (choices.length && !params) {
      pick = rng.weighted(choices.map((m) => ({ item: m, weight: m.weight })));
      params = planHardware(ctx, pick.fault);
      choices = choices.filter((m) => m !== pick);
    }
    // Nowhere for it to happen right now (everyone involved is busy or away): try again shortly.
    if (!params) {
      this.nextAt = now + 5 * MIN;
      return null;
    }
    const f = faultById(pick.fault);
    const hurtsMany = pick.fault === 'infra-cable';
    if (!queue.startGenerated(params, hurtsMany ? rng.int(30_000, 90_000) : rng.int(60_000, 240_000))) {
      this.nextAt = now + 5 * MIN;
      return null;
    }
    const site = (JSON.parse(String(params.atoms)) as { site: Site }[])[0].site;
    const b: Breakdown = { id: this.seq++, fault: f.id, site, at: now, fixedAt: null, shift };
    this.log.push(b);
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
    this.schedule(net);
    return b;
  }

  /** Called when a shift ends or the game pauses between shifts, so time off the clock isn't counted. */
  stopClock(): void {
    this.lastT = null;
  }

  /** Mean time between failures and mean time to repair, in game ms (null with too little data). */
  stats(): { failures: number; mtbf: number | null; mttr: number | null; open: number } {
    const fixed = this.log.filter((b) => b.fixedAt !== null);
    return {
      failures: this.log.length,
      mtbf: this.log.length ? this.runMs / this.log.length : null,
      mttr: fixed.length ? fixed.reduce((sum, b) => sum + (b.fixedAt! - b.at), 0) / fixed.length : null,
      open: this.log.length - fixed.length,
    };
  }

  exportState(): BreakageState {
    return { nextAt: this.nextAt, seq: this.seq, log: structuredClone(this.log), runMs: this.runMs, rng: this.rng.seedState };
  }

  importState(s: BreakageState | undefined): void {
    this.nextAt = s?.nextAt ?? null;
    this.seq = s?.seq ?? 1;
    this.log.splice(0, this.log.length, ...(s?.log ?? []));
    this.runMs = s?.runMs ?? 0;
    if (s?.rng !== undefined) this.rng.seedState = s.rng;
    this.lastT = null;
  }
}
