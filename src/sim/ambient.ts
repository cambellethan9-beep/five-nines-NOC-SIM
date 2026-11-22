// Background life in the office: PCs going to sleep and waking up (real link flaps on the
// access switches) and the routine log noise every real network has.

import { formatIp } from './ip';
import type { Network } from './network';

interface SleepState {
  wakeAt: number;
}

export class Ambient {
  private nextSleepAt: number;
  private nextNoiseAt: number;
  private readonly sleeping = new Map<string, SleepState>();

  /**
   * @param protectedIds devices that must never sleep (e.g. PCs in an open ticket)
   */
  constructor(
    private readonly net: Network,
    private readonly protectedIds: () => Set<string> = () => new Set(),
  ) {
    this.nextSleepAt = net.time + net.rng.int(90_000, 200_000);
    this.nextNoiseAt = net.time + net.rng.int(30_000, 90_000);
  }

  /** Processes everything due up to the current sim time (handles big jumps like walking). */
  update(): void {
    const net = this.net;
    for (const [id, s] of this.sleeping) {
      if (net.time >= s.wakeAt) {
        net.device(id).powered = true;
        this.sleeping.delete(id);
        net.commit();
      }
    }
    while (net.time >= this.nextSleepAt) {
      this.sleepSomeone();
      this.nextSleepAt += net.rng.int(150_000, 360_000);
    }
    while (net.time >= this.nextNoiseAt) {
      this.noise();
      this.nextNoiseAt += net.rng.int(45_000, 150_000);
    }
  }

  exportState() {
    return { nextSleepAt: this.nextSleepAt, nextNoiseAt: this.nextNoiseAt, sleeping: [...this.sleeping.entries()] };
  }

  importState(s: ReturnType<Ambient['exportState']>): void {
    this.nextSleepAt = s.nextSleepAt;
    this.nextNoiseAt = s.nextNoiseAt;
    this.sleeping.clear();
    for (const [id, st] of s.sleeping) this.sleeping.set(id, st);
  }

  isAsleep(id: string): boolean {
    return this.sleeping.has(id);
  }

  private staffPcs() {
    const blocked = this.protectedIds();
    return [...this.net.devices.values()].filter(
      (d) => d.kind === 'pc' && d.managed && d.id.startsWith('ws') && !blocked.has(d.id) && d.powered,
    );
  }

  private sleepSomeone(): void {
    const candidates = this.staffPcs();
    if (!candidates.length) return;
    const pc = this.net.rng.pick(candidates);
    pc.powered = false;
    this.sleeping.set(pc.id, { wakeAt: this.net.time + this.net.rng.int(120_000, 480_000) });
    this.net.commit();
  }

  private noise(): void {
    const net = this.net;
    const switches = [...net.devices.values()].filter((d) => d.managed && (d.kind === 'switch' || d.kind === 'l3switch' || d.kind === 'router'));
    const pcs = [...net.devices.values()].filter((d) => d.kind === 'pc' && d.managed && d.id.startsWith('ws'));
    if (!switches.length || !pcs.length) return;
    const target = net.rng.pick(switches);
    const pc = net.rng.pick(pcs);
    const pcIp = Object.values(pc.running.interfaces)[0]?.ip?.address;
    const src = pcIp !== undefined ? formatIp(pcIp) : '10.10.10.199';
    const roll = net.rng.next();
    if (roll < 0.7) {
      // A user's monitoring widget or printer driver probing with the wrong community string.
      net.log(target.id, `%SNMP-3-AUTHFAIL: Authentication failure for SNMP req from host ${src}`);
    } else {
      const user = net.rng.pick(['admin', 'root', 'cisco', 'tbrennan']);
      net.log(
        target.id,
        `%SEC_LOGIN-4-LOGIN_FAILED: Login failed [user: ${user}] [Source: ${src}] [localport: 22] [Reason: Login Authentication Failed] at ${loginTime(net)}`,
      );
    }
  }
}

/** "00:12:34 UTC Mon Mar 1 1993" as IOS writes it in login messages. */
export function loginTime(net: Network): string {
  const d = net.wallClock();
  const hms = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  const day = d.toLocaleString('en-US', { weekday: 'short', timeZone: 'UTC' });
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${hms} UTC ${day} ${month} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}
