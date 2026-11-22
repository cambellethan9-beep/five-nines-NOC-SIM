// Plain-text format for notes and edited docs, and the conversion both ways so an inherited doc can be
// opened in the editor, changed in place and saved without retyping it.
//
//   # Heading            - bullet           1. numbered
//   > callout            | a | b |  (table; a |---| line after the first row makes it the header)
//   ``` code fence ```   blank lines separate paragraphs

import type { Block } from './docs';

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
const isTableLine = (line: string) => line.trim().startsWith('|');
const isSeparator = (line: string) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());

export function textToBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  let ul: string[] = [];
  let ol: string[] = [];
  let note: string[] = [];
  let table: string[][] = [];
  let code: string[] | null = null;
  const flush = (keep?: 'ul' | 'ol' | 'note' | 'table' | 'para') => {
    if (keep !== 'para' && para.length) (blocks.push({ p: para.join(' ') }), (para = []));
    if (keep !== 'ul' && ul.length) (blocks.push({ ul }), (ul = []));
    if (keep !== 'ol' && ol.length) (blocks.push({ ol }), (ol = []));
    if (keep !== 'note' && note.length) (blocks.push({ note: note.join(' ') }), (note = []));
    if (keep !== 'table' && table.length) {
      const sep = table.findIndex((r) => r === SEP);
      const rows = table.filter((r) => r !== SEP);
      const head = sep === 1 ? rows[0] : [];
      const width = Math.max(...rows.map((r) => r.length));
      const pad = (r: string[]) => [...r, ...Array(Math.max(0, width - r.length)).fill('')];
      blocks.push({ table: { head: head.length ? pad(head) : [], rows: (head.length ? rows.slice(1) : rows).map(pad) } });
      table = [];
    }
  };
  const SEP: string[] = [];
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (code) {
        blocks.push({ code: code.join('\n') });
        code = null;
      } else {
        flush();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (/^#{1,3} /.test(line)) {
      flush();
      blocks.push({ h: line.replace(/^#{1,3} /, '').trim() });
    } else if (isTableLine(line)) {
      flush('table');
      table.push(isSeparator(line) && table.length ? SEP : cells(line));
    } else if (/^\s*[-*] /.test(line)) {
      flush('ul');
      ul.push(line.replace(/^\s*[-*] /, ''));
    } else if (/^\s*\d+[.)] /.test(line)) {
      flush('ol');
      ol.push(line.replace(/^\s*\d+[.)] /, ''));
    } else if (/^\s*>/.test(line)) {
      flush('note');
      note.push(line.replace(/^\s*> ?/, ''));
    } else if (!line.trim()) {
      flush();
    } else {
      flush('para');
      para.push(line.trim().replace(/^\\/, '')); // "\- Mike" is a paragraph that starts with a dash
    }
  }
  if (code) blocks.push({ code: (code as string[]).join('\n') });
  flush();
  return blocks;
}

/** The reverse: what the editor shows when you open an inherited doc. */
export function blocksToText(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if ('h' in b) out.push(`# ${b.h}`);
    else if ('p' in b) out.push(/^(#{1,3} |[-*] |\d+[.)] |>|\||```|\\)/.test(b.p) ? '\\' + b.p : b.p);
    else if ('code' in b) out.push('```\n' + b.code + '\n```');
    else if ('ul' in b) out.push(b.ul.map((x) => `- ${x}`).join('\n'));
    else if ('ol' in b) out.push(b.ol.map((x, i) => `${i + 1}. ${x}`).join('\n'));
    else if ('note' in b) out.push(`> ${b.note}`);
    else {
      const all = b.table.head.length ? [b.table.head, ...b.table.rows] : b.table.rows;
      const widths = all[0]?.map((_, j) => Math.max(3, ...all.map((r) => (r[j] ?? '').length))) ?? [];
      const row = (r: string[]) => '| ' + widths.map((w, j) => (r[j] ?? '').padEnd(w)).join(' | ') + ' |';
      const lines = all.map(row);
      if (b.table.head.length) lines.splice(1, 0, '| ' + widths.map((w) => '-'.repeat(w)).join(' | ') + ' |');
      out.push(lines.join('\n'));
    }
  }
  return out.join('\n\n');
}
