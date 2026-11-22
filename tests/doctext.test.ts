import { describe, expect, it } from 'vitest';
import { blocksToText, textToBlocks } from '../src/content/doctext';
import { Game } from '../src/game/game';

describe('editable docs', () => {
  it('every inherited doc survives a round trip through the editor unchanged', () => {
    const game = new Game('docs');
    for (const doc of game.docs) expect(textToBlocks(blocksToText(doc.blocks))).toEqual(doc.blocks);
  });

  it('editing the port map changes one row in place, saves, and can be reverted', () => {
    const game = new Game('docs2');
    const doc = game.docs.find((d) => d.blocks.some((b) => 'table' in b && b.table.head.includes('Desk')))!;
    const before = structuredClone(doc.blocks);
    const text = blocksToText(doc.blocks);
    const table = before.find((b) => 'table' in b && b.table.head.includes('Desk')) as { table: { rows: string[][] } };
    const row = table.table.rows[0];
    const line = text.split('\n').find((l) => l.includes(row[1]))!;
    game.updateDoc(doc.id, text.replace(line, line.replace(/\| 10\s*\|$/, '| 30 |')));
    const after = doc.blocks.find((b) => 'table' in b && b.table.head.includes('Desk')) as { table: { rows: string[][] } };
    expect(after.table.rows[0][7]).toBe('30');
    expect(after.table.rows.length).toBe(table.table.rows.length);
    expect(doc.editedAt).toBeDefined();
    const restored = new Game(game.seed, JSON.parse(JSON.stringify(game.toSave())));
    expect(restored.docs.find((d) => d.id === doc.id)!.blocks).toEqual(doc.blocks);
    game.revertDoc(doc.id);
    expect(doc.blocks).toEqual(before);
    expect(doc.original).toBeUndefined();
  });

  it('notes understand tables, numbered steps and callouts', () => {
    expect(textToBlocks('1. one\n2. two\n\n> careful\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 |')).toEqual([
      { ol: ['one', 'two'] },
      { note: 'careful' },
      { table: { head: ['a', 'b'], rows: [['1', '2'], ['3', '']] } },
    ]);
  });
});
