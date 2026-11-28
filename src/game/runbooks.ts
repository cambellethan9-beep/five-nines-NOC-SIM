// Runbooks: notebook notes that an employee can follow. Lines you mark as commands (stored with a leading "» ") are
// typed in order from the NOC PC; everything else is explanation for humans. Placeholders like {switch} and {port}
// fill in from the ticket. Triggers decide which new tickets a runbook picks up: one statement per line, each made
// of phrases joined by OR / AND; if any line is true, the runbook runs.

import type { Office } from '../content/office';
import { HostShell } from '../sim/host';
import { formatIp } from '../sim/ip';
import type { Network } from '../sim/network';
import type { Rng } from '../sim/rng';
import type { TicketDraft } from './ticketKit';

export const COMMAND_MARK = '» ';

export interface RunbookSettings {
  /** One statement per line: phrases joined by OR / AND. */
  triggers: string;
  enabled: boolean;
}

/** Anything with a title, a body and runbook settings: your notes, or an employee's own runbooks. */
export interface RunbookSource {
  id: string;
  title: string;
  body: string;
  runbook?: RunbookSettings;
}

type TicketLike = { draft: Pick<TicketDraft, 'subject' | 'description' | 'reporter'> };

// ---------------------------------------------------------------- marking commands

export function isCommandLine(line: string): boolean {
  return line.startsWith(COMMAND_MARK);
}

/** The commands in a runbook, in order (without the marker). */
export function commandsOf(body: string): string[] {
  return body
    .split('\n')
    .filter(isCommandLine)
    .map((l) => l.slice(COMMAND_MARK.length).trim())
    .filter(Boolean);
}

/**
 * "This is a command": toggles the marker on every non-empty line the selection touches. If they're all marked
 * already they're unmarked; otherwise they all get marked.
 */
export function toggleCommands(body: string, selStart: number, selEnd: number): string {
  const lines = body.split('\n');
  const last = Math.max(selStart, selEnd - 1);
  let pos = 0;
  const touched: number[] = [];
  lines.forEach((l, i) => {
    const start = pos;
    const end = pos + l.length;
    if (end >= selStart && start <= last && l.trim()) touched.push(i);
    pos = end + 1;
  });
  if (!touched.length) return body;
  const allMarked = touched.every((i) => isCommandLine(lines[i]));
  for (const i of touched) {
    if (allMarked) lines[i] = lines[i].slice(COMMAND_MARK.length);
    else if (!isCommandLine(lines[i])) lines[i] = COMMAND_MARK + lines[i];
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- triggers

export interface TriggerLine {
  /** OR of AND-groups of phrases. */
  any: string[][];
}

export type TriggerParse = { ok: true; lines: TriggerLine[] } | { ok: false; error: string; line: number };

/** Parses trigger statements. AND binds tighter than OR; operators are uppercase so phrases can say "and"/"or". */
export function parseTriggers(text: string): TriggerParse {
  const lines: TriggerLine[] = [];
  const raw = text.split('\n');
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i].trim();
    if (!l) continue;
    if (/^(AND|OR)(\s|$)/.test(l) || /(^|\s)(AND|OR)$/.test(l)) return { ok: false, error: "A statement can't start or end with AND / OR.", line: i + 1 };
    if (/(^|\s)(AND|OR)\s+(AND|OR)(\s|$)/.test(l)) return { ok: false, error: 'Two operators in a row.', line: i + 1 };
    const any = l.split(/\s+OR\s+/).map((part) => part.split(/\s+AND\s+/).map((p) => p.trim().replace(/^["']|["']$/g, '').toLowerCase()));
    if (any.some((g) => g.some((p) => !p || p === 'and' || p === 'or'))) return { ok: false, error: 'Two operators in a row, or an empty phrase.', line: i + 1 };
    lines.push({ any });
  }
  return { ok: true, lines };
}

/** Does this ticket match? Phrases are looked for in its subject and description. */
export function triggerMatches(text: string, ticket: TicketLike): boolean {
  const p = parseTriggers(text);
  if (!p.ok || !p.lines.length) return false;
  const hay = `${ticket.draft.subject}\n${ticket.draft.description}`.toLowerCase();
  return p.lines.some((line) => line.any.some((group) => group.every((phrase) => hay.includes(phrase))));
}

/** The first enabled runbook whose triggers match the ticket. */
export function matchRunbook(runbooks: RunbookSource[], ticket: TicketLike): RunbookSource | null {
  return runbooks.find((r) => r.runbook?.enabled && commandsOf(r.body).length && triggerMatches(r.runbook.triggers, ticket)) ?? null;
}

// ---------------------------------------------------------------- placeholders

export const PLACEHOLDERS: { key: string; what: string }[] = [
  { key: '{pc}', what: "the reporter's PC name (CR-WS07)" },
  { key: '{ip}', what: "the reporter's IP address" },
  { key: '{switch}', what: "the reporter's access switch management address (for ssh {switch})" },
  { key: '{switchname}', what: "that switch's name (CR-ACC1)" },
  { key: '{port}', what: 'the switch port the PC is on (Fa0/7)' },
  { key: '{floor}', what: '1 or 2' },
  { key: '{printer}', what: "the reporter's floor printer address" },
  { key: '{core}', what: 'CR-CORE1 (10.10.99.1)' },
  { key: '{router}', what: 'CR-RTR1 (10.0.0.1)' },
];

const MGMT: Record<string, string> = { acc1: '10.10.99.11', acc2: '10.10.99.12', core1: '10.10.99.1', rtr1: '10.0.0.1' };

export function placeholderValues(net: Network, ticket: TicketLike): Record<string, string> {
  const pc = ticket.draft.reporter.pcId;
  const dev = net.device(pc);
  const nic = Object.keys(dev.hardware)[0];
  const peer = net.peerOf(pc, nic);
  const sw = peer && MGMT[peer.device] ? peer.device : 'acc1';
  const ip = dev.running.interfaces[nic]?.ip?.address;
  return {
    '{pc}': dev.running.hostname,
    '{ip}': ip !== undefined ? formatIp(ip) : '0.0.0.0',
    '{switch}': MGMT[sw],
    '{switchname}': net.device(sw).running.hostname,
    '{port}': (peer?.iface ?? 'FastEthernet0/1').replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gi'),
    '{floor}': sw === 'acc2' ? '2' : '1',
    '{printer}': sw === 'acc2' ? '10.10.30.22' : '10.10.30.21',
    '{core}': MGMT.core1,
    '{router}': MGMT.rtr1,
  };
}

export function fill(command: string, values: Record<string, string>): string {
  return command.replace(/\{[a-z]+\}/g, (m) => values[m] ?? m);
}

/** The commands as they'd be typed for this ticket (the dry run). */
export function dryRun(net: Network, body: string, ticket: TicketLike): string[] {
  const values = placeholderValues(net, ticket);
  return commandsOf(body).map((c) => fill(c, values));
}

// ---------------------------------------------------------------- running

export interface RunLogEntry {
  typed: string;
  output: string[];
  /** The command they meant to type, when they made a typo. */
  meant?: string;
}

/** A typo: a dropped, doubled or swapped character somewhere in the command. */
export function typo(cmd: string, rng: Rng): string {
  if (cmd.length < 3) return cmd + cmd.slice(-1);
  const i = rng.int(1, cmd.length - 2);
  const kind = rng.int(0, 2);
  if (kind === 0) return cmd.slice(0, i) + cmd.slice(i + 1);
  if (kind === 1) return cmd.slice(0, i) + cmd[i] + cmd.slice(i);
  return cmd.slice(0, i - 1) + cmd[i] + cmd[i - 1] + cmd.slice(i + 1);
}

const ERROR_LINE = /^%|not recognized|Unknown command|Invalid input/i;

/**
 * Types a runbook's commands at the NOC PC, as an employee would: placeholders filled in, host keys accepted,
 * confirmations answered with Enter, typos at the given rate. Careful employees retype a rejected command once.
 */
export function runRunbook(net: Network, office: Office, body: string, ticket: TicketLike, opts: { typoRate: number; noticesErrors: boolean; rng: Rng }): RunLogEntry[] {
  const shell = new HostShell(net, office.home, { ...office.hostOptions[office.home], knownHosts: new Map() });
  const home = shell.promptText();
  const values = placeholderValues(net, ticket);
  const log: RunLogEntry[] = [];
  const send = (typed: string, meant?: string): string[] => {
    const r = shell.input(typed);
    const output = [...r.output, ...(r.delayed?.output ?? [])];
    log.push({ typed, output, ...(meant !== undefined && meant !== typed ? { meant } : {}) });
    // Answer what a command can leave waiting: host keys, [confirm] and "Destination filename [x]?" prompts.
    for (let i = 0; i < 3; i++) {
      const p = shell.promptText();
      if (/\(yes\/no.*\)\?\s*$/.test(p)) send('yes');
      else if (/\[confirm\]\s*$|\]\?\s*$|\[yes\/no\]:\s*$/.test(p)) send('');
      else break;
    }
    return output;
  };
  for (const raw of commandsOf(body)) {
    const cmd = fill(raw, values);
    const typed = opts.rng.chance(opts.typoRate) ? typo(cmd, opts.rng) : cmd;
    const out = send(typed, cmd);
    if (typed !== cmd && opts.noticesErrors && out.some((l) => ERROR_LINE.test(l))) send(cmd);
  }
  // Leave every device cleanly.
  for (let i = 0; i < 6 && shell.promptText() !== home; i++) send(/\(config/.test(shell.promptText()) ? 'end' : 'exit');
  return log;
}
