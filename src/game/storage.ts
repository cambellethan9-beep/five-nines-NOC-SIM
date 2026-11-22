// Saving to the browser. Every read and write is guarded: storage can be missing or blocked
// (private windows, embedded previews), and the game must still run without it.
//
// Your documentation (notebook and your edits to the inherited docs) is kept separately from the game save, so it
// carries over to every new game, like a rebirth. Only clearLibrary() removes it.

import type { Doc } from '../content/docs';
import { Game, SAVE_VERSION, type Note, type SaveFile } from './game';

const KEY = 'noc-sim.save';
const LIBRARY_KEY = 'noc-sim.library';

export interface Library {
  version: 1;
  notes: Note[];
  /** Inherited docs you edited: your version and the predecessor's original. */
  docs: Pick<Doc, 'id' | 'blocks' | 'editedAt' | 'original'>[];
}

export function libraryOf(game: Game): Library {
  return {
    version: 1,
    notes: structuredClone(game.notes),
    docs: game.docs.filter((d) => d.editedAt !== undefined).map((d) => ({ id: d.id, blocks: structuredClone(d.blocks), editedAt: d.editedAt, original: structuredClone(d.original) })),
  };
}

/** Puts your documentation into a game (a new one, or a save made before the library existed). */
export function applyLibrary(game: Game, lib: Library): void {
  const have = new Set(game.notes.map((n) => n.id));
  game.notes = [...game.notes, ...lib.notes.filter((n) => !have.has(n.id))];
  for (const e of lib.docs) {
    const doc = game.docs.find((d) => d.id === e.id);
    if (!doc || doc.editedAt !== undefined) continue;
    doc.blocks = structuredClone(e.blocks);
    doc.editedAt = 0;
    doc.original = structuredClone(e.original ?? doc.blocks);
  }
}

export function saveLibrary(game: Game): boolean {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(libraryOf(game)));
    return true;
  } catch {
    return false;
  }
}

export function loadLibrary(): Library | null {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY);
    if (!raw) return null;
    const lib = JSON.parse(raw) as Library;
    return lib.version === 1 ? lib : null;
  } catch {
    return null;
  }
}

/** Deletes your notebook and doc edits for good (the Settings dialog asks three times first). */
export function clearLibrary(): void {
  try {
    localStorage.removeItem(LIBRARY_KEY);
  } catch {
    // nothing to clear
  }
}

export function saveGame(game: Game): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(game.toSave()));
    saveLibrary(game);
    return true;
  } catch {
    return false;
  }
}

/** Loads the saved game, or null if there is none (or it's from an incompatible version). */
export function loadGame(): Game | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const save = JSON.parse(raw) as SaveFile;
    if (save.version !== SAVE_VERSION) return null;
    const game = new Game(save.seed, save);
    const lib = loadLibrary();
    if (lib) applyLibrary(game, lib);
    return game;
  } catch {
    return null;
  }
}

/** A brand-new game that keeps your documentation. */
export function newGameWithLibrary(): Game {
  const game = new Game();
  const lib = loadLibrary();
  if (lib) applyLibrary(game, lib);
  return game;
}

/** Removes the game save. Your documentation is kept. */
export function clearSave(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}
