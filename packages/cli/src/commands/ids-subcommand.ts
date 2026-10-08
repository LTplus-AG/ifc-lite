/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared plumbing for the IDS authoring subcommands (`ifc-lite ids audit |
 * lint | fmt | diff`).
 *
 * Exit codes are the same for all of them, so a CI step can tell "the IDS
 * has problems" from "the command could not run":
 *   0  clean
 *   1  findings (audit/lint errors, unformatted file, documents differ)
 *   2  usage error, unreadable file, or output this build cannot write
 *
 * Usage errors set `process.exitCode` instead of calling `process.exit`, so
 * the commands can run in-process (tests, `ifc-lite gym`-style hosts).
 */

import { readFile } from 'node:fs/promises';

export const EXIT_CLEAN = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_UNUSABLE = 2;

/** Thrown for a condition that ends the command with exit code 2. */
export class IdsUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdsUsageError';
  }
}

/** Positionals, skipping the value that follows each flag in `valueFlags`. */
export function positionals(args: readonly string[], valueFlags: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('-')) {
      if (valueFlags.has(arg)) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** Refuse flags the subcommand does not know, so a typo is not a silent no-op. */
export function rejectUnknownFlags(args: readonly string[], known: ReadonlySet<string>, valueFlags: ReadonlySet<string>): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) continue;
    if (!known.has(arg) && !valueFlags.has(arg)) throw new IdsUsageError(`unknown flag ${arg}`);
    if (valueFlags.has(arg)) {
      if (i + 1 >= args.length) throw new IdsUsageError(`${arg} needs a value`);
      i++;
    }
  }
}

export async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err) {
    throw new IdsUsageError(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Run a subcommand body, turning `IdsUsageError` into exit code 2. */
export async function runIdsSubcommand(body: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await body();
  } catch (err) {
    if (!(err instanceof IdsUsageError)) throw err;
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = EXIT_UNUSABLE;
  }
}

/** `1 error, 2 warnings, 0 info` */
export function countLine(counts: { error: number; warning: number; info: number }): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return `${plural(counts.error, 'error')}, ${plural(counts.warning, 'warning')}, ${counts.info} info`;
}

export function tally<T extends { severity: 'error' | 'warning' | 'info' }>(items: readonly T[]): { error: number; warning: number; info: number } {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const item of items) counts[item.severity]++;
  return counts;
}
