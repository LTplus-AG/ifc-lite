/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite <command> --help` has to describe that command.
 *
 * It described none of them: `main()` answered `args.includes('--help')`
 * BEFORE dispatch, with the command still sitting in `args`, so all 37
 * subcommands printed the same global page (#5527). The CLI's own docs tell
 * LLM users to "discover all capabilities by running `ifc-lite --help`", and
 * there was no second level to discover. It also made the real per-command
 * help written in `layer.ts`, `ref.ts` and `ext.ts` unreachable: those
 * handlers test for `--help` and were never given the chance.
 *
 * Per-command help is derived from the `Commands:` block of the same literal
 * `buildHelp` returns, so these cases check the derivation is total (every
 * documented command resolves) rather than pinning 37 strings that would rot.
 */

import { describe, it, expect } from 'vitest';
import * as help from './help.js';

/**
 * A NAMESPACE import, deliberately. `buildCommandHelp` and `helpCommandNames`
 * are new, and a named import of a symbol the module does not export is a
 * link-time failure -- so with the fix reverted this file would fail to LOAD
 * rather than fail its assertions, and a revert oracle cannot tell those apart
 * (it reports REVERT-BROKE-BUILD, i.e. "nothing observed"). Reading them off
 * the namespace makes a reverted build fail the cases below instead, which is
 * the observation this suite exists to make.
 */
const buildCommandHelp: typeof help.buildCommandHelp | undefined = help.buildCommandHelp;
const helpCommandNames: typeof help.helpCommandNames | undefined = help.helpCommandNames;

const VERSION = '9.9.9';
const COMMANDS = helpCommandNames?.(VERSION) ?? [];

describe('the help text documents a useful number of commands', () => {
  it('parses the Commands block', () => {
    // A parse that silently found nothing would make every case below vacuous.
    expect(COMMANDS.length).toBeGreaterThan(20);
    expect(COMMANDS).toContain('info');
    expect(COMMANDS).toContain('export');
    expect(COMMANDS).toContain('diagnose-geometry');
  });
});

describe('every documented command has its own help', () => {
  it.each(COMMANDS)('%s', (command) => {
    const text = buildCommandHelp?.(VERSION, command) ?? null;

    expect(text, `${command} resolved to no help`).not.toBeNull();
    // It names the command...
    expect(text).toContain(`ifc-lite ${command}`);
    // ...and it is NOT the global page, which is what every command used to get.
    expect(text).not.toContain('BIM toolkit for the terminal');
    expect(text!.length).toBeLessThan(help.buildHelp(VERSION).length);
  });
});

describe('multi-line entries keep their continuation rows', () => {
  it('schedule carries its flag list, not just its first line', () => {
    const text = buildCommandHelp?.(VERSION, 'schedule') ?? null;
    expect(text).toContain('--preset');
    expect(text).toContain('--subtotals');
  });
});

describe('an undocumented name has no command help', () => {
  it('returns null so the caller can fall back to the global page', () => {
    expect(buildCommandHelp?.(VERSION, 'not-a-command') ?? null).toBeNull();
  });
});
