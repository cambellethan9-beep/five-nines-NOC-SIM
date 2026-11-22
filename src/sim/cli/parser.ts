// IOS-style command parser: a tree of keywords and parameters with unique-prefix
// abbreviation ("sh ip int br"), context help ("?"), Tab completion and caret error markers.

import { parseIfName, fullIfName } from '../ifnames';
import { parseIp } from '../ip';

export type ParamKind = 'ip' | 'mask' | 'number' | 'word' | 'line' | 'iface';

export interface ParamSpec {
  kind: ParamKind;
  name: string;
  /** Shown in `?` output, e.g. "A.B.C.D", "<1-4094>", "WORD", "LINE". */
  label: string;
  min?: number;
  max?: number;
}

export type Args = Record<string, string | number | undefined>;

export interface CommandNode<C> {
  keyword?: string;
  param?: ParamSpec;
  help: string;
  children: CommandNode<C>[];
  run?: (ctx: C, args: Args) => void;
}

export interface Token {
  text: string;
  start: number;
}

export function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) tokens.push({ text: m[0], start: m.index });
  return tokens;
}

/** Parses a pattern token: "show", "<ip:addr>", "<number:vlan:1-4094>", "<line:text>". */
function parsePatternToken(tok: string): { keyword?: string; param?: ParamSpec } {
  if (!tok.startsWith('<')) return { keyword: tok };
  const [kind, name, rangeText] = tok.slice(1, -1).split(':') as [ParamKind, string, string | undefined];
  const param: ParamSpec = { kind, name, label: kind.toUpperCase() };
  if (kind === 'ip') param.label = 'A.B.C.D';
  if (kind === 'mask') param.label = 'A.B.C.D';
  if (kind === 'line') param.label = 'LINE';
  if (kind === 'word') param.label = 'WORD';
  if (kind === 'iface') param.label = 'Interface';
  if (kind === 'number' && rangeText) {
    const [min, max] = rangeText.split('-').map(Number);
    param.min = min;
    param.max = max;
    param.label = `<${min}-${max}>`;
  }
  return { param };
}

export class CommandTree<C> {
  readonly root: CommandNode<C> = { help: '', children: [] };

  /**
   * Adds a command. `pattern` is space-separated tokens; `help` gives help text per keyword
   * and per param name, e.g. { show: 'Show running system information', addr: 'IP address' }.
   */
  add(pattern: string, help: Record<string, string>, run: (ctx: C, args: Args) => void): this {
    let node = this.root;
    for (const raw of pattern.split(/\s+/)) {
      const spec = parsePatternToken(raw);
      let child = node.children.find((c) =>
        spec.keyword ? c.keyword === spec.keyword : c.param && c.param.kind === spec.param!.kind && c.param.name === spec.param!.name,
      );
      if (!child) {
        const helpKey = spec.keyword ?? spec.param!.name;
        child = { ...spec, help: help[helpKey] ?? '', children: [] };
        node.children.push(child);
      } else if (!child.help) {
        child.help = help[spec.keyword ?? spec.param!.name] ?? '';
      }
      node = child;
    }
    node.run = run;
    return this;
  }
}

export type ParseResult<C> =
  | { ok: true; node: CommandNode<C>; args: Args }
  | { ok: false; error: 'invalid'; caret: number }
  | { ok: false; error: 'ambiguous'; text: string }
  | { ok: false; error: 'incomplete' };

function validateParam(spec: ParamSpec, text: string): string | number | null {
  switch (spec.kind) {
    case 'ip':
    case 'mask':
      return parseIp(text) === null ? null : text;
    case 'number': {
      if (!/^\d+$/.test(text)) return null;
      const n = Number(text);
      if (spec.min !== undefined && (n < spec.min || n > spec.max!)) return null;
      return n;
    }
    case 'word':
    case 'line':
      return text;
    case 'iface': {
      const parsed = parseIfName(text);
      return parsed ? fullIfName(parsed) : null;
    }
  }
}

interface StepResult<C> {
  node?: CommandNode<C>;
  consumed?: number;
  value?: string | number;
  ambiguous?: boolean;
  /** Characters of the token that matched some keyword before failing (for caret placement). */
  partial?: number;
}

function step<C>(node: CommandNode<C>, tokens: Token[], i: number, line: string): StepResult<C> {
  const text = tokens[i].text.toLowerCase();
  const keywords = node.children.filter((c) => c.keyword);
  const exact = keywords.find((c) => c.keyword!.toLowerCase() === text);
  if (exact) return { node: exact, consumed: 1 };
  const prefixed = keywords.filter((c) => c.keyword!.toLowerCase().startsWith(text));
  if (prefixed.length === 1) return { node: prefixed[0], consumed: 1 };
  if (prefixed.length > 1) return { ambiguous: true };

  for (const child of node.children) {
    if (!child.param) continue;
    if (child.param.kind === 'line') {
      return { node: child, consumed: tokens.length - i, value: line.slice(tokens[i].start).trimEnd() };
    }
    if (child.param.kind === 'iface') {
      // Interfaces may be typed with a space: "fa 0/1".
      if (i + 1 < tokens.length && /^[a-zA-Z-]+$/.test(tokens[i].text)) {
        const joined = validateParam(child.param, tokens[i].text + tokens[i + 1].text);
        if (joined !== null) return { node: child, consumed: 2, value: joined };
      }
    }
    const value = validateParam(child.param, tokens[i].text);
    if (value !== null) return { node: child, consumed: 1, value };
  }

  let partial = 0;
  for (const k of keywords) {
    let n = 0;
    const kw = k.keyword!.toLowerCase();
    while (n < text.length && n < kw.length && kw[n] === text[n]) n++;
    partial = Math.max(partial, n);
  }
  return { partial };
}

export function parse<C>(tree: CommandTree<C>, line: string): ParseResult<C> {
  const tokens = tokenize(line);
  let node = tree.root;
  const args: Args = {};
  let i = 0;
  while (i < tokens.length) {
    const r = step(node, tokens, i, line);
    if (r.ambiguous) return { ok: false, error: 'ambiguous', text: line.slice(0, tokens[i].start + tokens[i].text.length) };
    if (!r.node) return { ok: false, error: 'invalid', caret: tokens[i].start + (r.partial ?? 0) };
    if (r.node.param) {
      args[r.node.param.name] = r.value;
      args[`@${r.node.param.name}`] = tokens[i].start;
    }
    node = r.node;
    i += r.consumed!;
  }
  if (!node.run) return { ok: false, error: 'incomplete' };
  return { ok: true, node, args };
}

/** Walks all complete tokens; returns the node reached, or null if the prefix is invalid. */
function walkComplete<C>(tree: CommandTree<C>, tokens: Token[], line: string): CommandNode<C> | null {
  let node = tree.root;
  let i = 0;
  while (i < tokens.length) {
    const r = step(node, tokens, i, line);
    if (!r.node || r.node.param?.kind === 'line') return r.node?.param?.kind === 'line' ? r.node : null;
    node = r.node;
    i += r.consumed!;
  }
  return node;
}

export interface HelpLine {
  label: string;
  help: string;
}

/**
 * Context help for a line ending in "?".
 * "sh?" lists keywords starting with "sh"; "show ?" lists everything that can follow.
 */
export function help<C>(tree: CommandTree<C>, line: string): { lines: HelpLine[]; partial: boolean } | null {
  const partialWord = !/\s$/.test(line) && line.length > 0;
  const tokens = tokenize(line);
  const complete = partialWord ? tokens.slice(0, -1) : tokens;
  const node = walkComplete(tree, complete, line);
  if (!node) return null;
  if (partialWord) {
    const prefix = tokens[tokens.length - 1].text.toLowerCase();
    const matches = node.children.filter((c) => c.keyword?.toLowerCase().startsWith(prefix));
    return { lines: matches.map((c) => ({ label: c.keyword!, help: c.help })), partial: true };
  }
  const lines: HelpLine[] = node.children
    .map((c) => ({ label: c.keyword ?? c.param!.label, help: c.help }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (node.run) lines.push({ label: '<cr>', help: '' });
  return { lines, partial: false };
}

/** Tab completion: completes the last word if it uniquely matches a keyword. */
export function complete<C>(tree: CommandTree<C>, line: string): string | null {
  if (/\s$/.test(line) || line.length === 0) return null;
  const tokens = tokenize(line);
  const node = walkComplete(tree, tokens.slice(0, -1), line);
  if (!node) return null;
  const last = tokens[tokens.length - 1];
  const prefix = last.text.toLowerCase();
  const matches = node.children.filter((c) => c.keyword?.toLowerCase().startsWith(prefix));
  if (matches.length !== 1) return null;
  return line.slice(0, last.start) + matches[0].keyword + ' ';
}

export function formatHelp(lines: HelpLine[], partial: boolean): string[] {
  if (partial) {
    // IOS prints partial matches on one line: "show  ssh  start-chat"
    return [lines.map((l) => l.label).join('  ')];
  }
  const width = Math.max(...lines.map((l) => l.label.length), 0);
  return lines.map((l) => `  ${l.label.padEnd(width)}  ${l.help}`.trimEnd());
}
