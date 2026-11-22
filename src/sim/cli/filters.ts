// Output modifiers after a pipe: `show run | include ip`, `| exclude`, `| begin`, `| section`, `| count`.
// Like IOS, the pattern is a regular expression (case-sensitive) and the pipe only works on show commands.

export type FilterKind = 'include' | 'exclude' | 'begin' | 'section' | 'count';
const KINDS: FilterKind[] = ['begin', 'count', 'exclude', 'include', 'section'];

export const FILTER_HELP: { label: string; help: string }[] = [
  { label: 'append', help: 'Append redirected output to URL (URLs supporting append operation only)' },
  { label: 'begin', help: 'Begin with the line that matches' },
  { label: 'count', help: 'Count number of lines which match regular expression' },
  { label: 'exclude', help: 'Exclude lines that match' },
  { label: 'format', help: 'Format the output using the specified spec file' },
  { label: 'include', help: 'Include lines that match' },
  { label: 'redirect', help: 'Redirect output to URL' },
  { label: 'section', help: 'Filter a section of output' },
  { label: 'tee', help: 'Copy output to URL' },
];

export interface Filter {
  kind: FilterKind;
  regex: RegExp | null;
  pattern: string;
}

export type PipeParse =
  | { ok: true; command: string; filter: Filter | null }
  | { ok: false; error: 'invalid'; caret: number }
  | { ok: false; error: 'incomplete' }
  | { ok: false; error: 'regex' };

/** Splits "show run | i ip address" into the command and its filter. `line` is the full typed line. */
export function splitPipe(line: string): PipeParse {
  const bar = line.indexOf('|');
  if (bar < 0) return { ok: true, command: line, filter: null };
  const command = line.slice(0, bar);
  const rest = line.slice(bar + 1);
  const m = /^(\s*)(\S+)(\s+(.*))?$/.exec(rest);
  if (!m) return { ok: false, error: 'incomplete' };
  const word = m[2].toLowerCase();
  const kind = KINDS.find((k) => k.startsWith(word));
  const known = FILTER_HELP.some((f) => f.label.startsWith(word));
  if (!kind) {
    // append/redirect/tee/format exist on real IOS but write to files; not supported here.
    if (known) return { ok: false, error: 'invalid', caret: bar + 1 + m[1].length };
    return { ok: false, error: 'invalid', caret: bar + 1 + m[1].length };
  }
  const pattern = (m[4] ?? '').trimEnd();
  if (!pattern) return { ok: false, error: 'incomplete' };
  let regex: RegExp | null = null;
  try {
    regex = new RegExp(pattern);
  } catch {
    return { ok: false, error: 'regex' };
  }
  return { ok: true, command, filter: { kind, regex, pattern } };
}

/** Applies a filter to command output. Blank lines count as lines, as on IOS. */
export function applyFilter(lines: string[], f: Filter): string[] {
  const all = lines.flatMap((l) => l.split('\n'));
  const re = f.regex!;
  switch (f.kind) {
    case 'include':
      return all.filter((l) => re.test(l));
    case 'exclude':
      return all.filter((l) => !re.test(l));
    case 'begin': {
      const i = all.findIndex((l) => re.test(l));
      return i < 0 ? [] : all.slice(i);
    }
    case 'count':
      return [`Number of lines which match regexp = ${all.filter((l) => re.test(l)).length}`];
    case 'section': {
      // A section is a line plus the indented lines under it. If the header or any child matches,
      // IOS prints the whole section (`show run | section ip address` lists each interface that has one).
      const out: string[] = [];
      for (let i = 0; i < all.length; i++) {
        const block = [all[i]];
        while (i + 1 < all.length && /^\s/.test(all[i + 1]) && !/^\s/.test(block[0])) block.push(all[++i]);
        if (block.some((l) => re.test(l))) out.push(...block);
      }
      return out;
    }
  }
}
