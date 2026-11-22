// Shared pieces for ticket templates: the draft/template types and helpers for picking people and checking fixes.

import type { Office, Person } from '../content/office';
import type { Network } from '../sim/network';
import type { Rng } from '../sim/rng';
import { reachService } from './services';
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

export const FS01 = '10.10.20.11';
export const INTERNET = '8.8.8.8';
export const NIC = 'FastEthernet0';

/** Runs a check with the given PCs awake (a sleeping PC can't prove anything). */
export function withAwake<T>(net: Network, pcIds: string[], fn: () => T): T {
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

export function reaches(net: Network, pcId: string, ...targets: string[]): boolean {
  return withAwake(net, [pcId], () => targets.every((t) => reachService(net, pcId, t)));
}

export function person(env: Env, pcId: unknown): Person {
  const p = env.office.people.find((x) => x.pcId === pcId);
  if (!p) throw new Error(`No person at ${String(pcId)}`);
  return p;
}

export function hasPort(net: Network, p: Person): boolean {
  return net.peerOf(p.pcId, NIC) !== null;
}

export function freePeople(ctx: TemplateContext): Person[] {
  return ctx.office.people.filter((p) => !ctx.busyPcs.has(p.pcId) && hasPort(ctx.net, p));
}

export function pickPerson(ctx: TemplateContext): Params {
  return { pcId: ctx.rng.pick(freePeople(ctx)).pcId, variant: ctx.rng.int(0, 2) };
}

/** "CR-ACC1 Fa0/7": the switch port a PC is patched into. */
export function portLabel(net: Network, pcId: string): string {
  const peer = net.peerOf(pcId, NIC);
  if (!peer) return 'an unpatched port';
  return `${net.device(peer.device).running.hostname} ${peer.iface.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gi')}`;
}

export function floorOf(net: Network, pcId: string): 'acc1' | 'acc2' {
  return net.peerOf(pcId, NIC)?.device === 'acc2' ? 'acc2' : 'acc1';
}

export function variant(lines: string[], params: Params): string {
  return lines[Number(params.variant ?? 0) % lines.length];
}

/** Empty desks: unused access ports 11-19 with nothing plugged in. */
export function freePorts(net: Network, swId: string): string[] {
  const ports: string[] = [];
  for (let i = 11; i <= 19; i++) {
    const name = `FastEthernet0/${i}`;
    if (!net.linkAt(swId, name)) ports.push(name);
  }
  return ports;
}

/** Builds a one-person incident where the user just needs FS01 and the internet back. */
export function userIncident(
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

export const userTicket = (id: string, difficulty: Difficulty, build: TicketTemplate['build']): TicketTemplate => ({
  id,
  difficulty,
  canStart: (ctx) => freePeople(ctx).length > 0,
  plan: pickPerson,
  build,
});

