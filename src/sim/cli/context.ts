// Shared by the console session and the per-feature command files (ACLs, NAT, routing protocols...).

import type { Network } from '../network';
import type { Device } from '../types';
import type { CliResult, CliSession } from './session';
import type { CommandTree } from './parser';

export interface Ctx {
  s: CliSession;
  net: Network;
  dev: Device;
  out: string[];
  result: CliResult;
  /** Character offset of the command within the typed line (non-zero for `do`). */
  offset: number;
}

export type Tree = CommandTree<Ctx>;

export const INVALID = "% Invalid input detected at '^' marker.";

/** Prints the IOS caret under `column` of the typed command, then the invalid-input message. */
export function caret(ctx: Ctx, column: number): void {
  ctx.out.push(' '.repeat(ctx.s.promptText().length + ctx.offset + column) + '^', INVALID, '');
}

export function commit(ctx: Ctx): void {
  ctx.net.commit();
}
