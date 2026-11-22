// Saving to the browser. Every read and write is guarded: storage can be missing or blocked
// (private windows, embedded previews), and the game must still run without it.

import { Game, SAVE_VERSION, type SaveFile } from './game';

const KEY = 'noc-sim.save';

export function saveGame(game: Game): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(game.toSave()));
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
    return new Game(save.seed, save);
  } catch {
    return null;
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}
