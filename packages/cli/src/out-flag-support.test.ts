/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `--out` is per-command, and the set of commands that take it has to match
 * the set that actually parses it.
 *
 * It used to be advertised under the global `Options:` block as "Write output
 * to file instead of stdout". Eleven commands -- `info`, `query`, `stats`,
 * `validate`, `props`, `schema`, `diff`, `ask`, `schedule`, `clash`, `ids` --
 * parse no such flag, so `info --json --out f.json` wrote to stdout, created
 * nothing, and exited 0 (#5528).
 *
 * The risk in the fix is a hand-maintained list drifting from reality in
 * either direction: a command that gains `--out` and is not listed gets its
 * own flag refused, and one that loses it keeps silently swallowing. So this
 * derives the truth from the command sources and compares.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHelp } from './help.js';
import { COMMANDS_WITH_OUT } from './out-flag-commands.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMMAND_DIR = resolve(__dirname, 'commands');

/**
 * Every name `main()` dispatches on. The switch IS the list of commands, and
 * it has no runtime surface to ask, so this reads it.
 */
function dispatchedCommands(): string[] {
  const source = readFileSync(join(__dirname, 'index.ts'), 'utf-8');
  return [...source.matchAll(/^\s*case '([a-z][\w-]*)':/gm)].map((m) => m[1]);
}

const COMMANDS: string[] = [...new Set(dispatchedCommands())];

/**
 * Does this command's own source read `--out`? A command with no file of its
 * own name (`bcf` and friends dispatch from elsewhere) is reported as unknown
 * rather than as "no", so it can be excluded instead of silently counted.
 */
function readsOutFlag(command: string): boolean | undefined {
  const file = join(COMMAND_DIR, `${command}.ts`);
  if (!existsSync(file)) return undefined;
  // @source-text-assertion-ok the subject IS which source parses the flag; there is no runtime surface that reports it
  return readFileSync(file, 'utf-8').includes("'--out'");
}

describe('the --out support list matches the commands that parse it', () => {
  it('found a plausible command list to check', () => {
    expect(COMMANDS.length).toBeGreaterThan(20);
    expect(COMMANDS_WITH_OUT.size).toBeGreaterThan(5);
  });

  it.each(COMMANDS)('%s', (command) => {
    const parses = readsOutFlag(command);
    if (parses === undefined) return; // no single-file source; nothing to compare

    expect(
      COMMANDS_WITH_OUT.has(command),
      parses
        ? `${command} parses --out but is missing from COMMANDS_WITH_OUT, so its own flag is refused`
        : `${command} is listed in COMMANDS_WITH_OUT but parses no --out, so the flag is silently swallowed`,
    ).toBe(parses);
  });
});

describe('the global help no longer advertises --out as global', () => {
  it('does not list it under Options', () => {
    const text = buildHelp('9.9.9');
    const options = text.slice(text.indexOf('  Options:'), text.indexOf('  Examples:'));
    expect(options).not.toContain('--out');
  });
});
