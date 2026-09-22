/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5209 finding 3: `ids --locale de file.ifc rules.ids` used to consume the
 * flag's VALUE as the first positional (`ifcPath`), because `idsCommand`
 * filtered positionals with `args.filter(a => !a.startsWith('-'))` -- which
 * exempts `--locale` itself but not the `de` that follows it. `diff.ts`'s
 * `VALUE_FLAGS`/`diffPositionals()` and `mcp.ts`'s `MCP_VALUE_FLAGS`/
 * `collectModelPaths()` already dodge this for their own commands; `ids.ts`
 * now carries the same shape via its own `VALUE_FLAGS`/`idsPositionals()`.
 *
 * Proven by direct invocation on `upstream/main` 0eafae1cb:
 *   $ node dist/index.js ids tiny.ifc rules.ids            # PASS, exit 0
 *   $ node dist/index.js ids --locale de tiny.ifc rules.ids
 *   Error [ids]: ENOENT: no such file or directory, open 'de'
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { idsCommand } from './ids.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = resolve(here, '../../../ids/src/__corpus__/buildingsmart-ids/classification');
const PASS_IFC = resolve(corpus, 'pass-systems_should_match_exactly_1_5.ifc');
const PASS_IDS = resolve(corpus, 'pass-systems_should_match_exactly_1_5.ids');

function silenceOutput() {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('idsCommand — value-taking flag ordering (#5209 finding 3)', () => {
  it('resolves the real file paths when --locale precedes the positionals', async () => {
    silenceOutput();
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      // RED before the fix: `de` (the flag's value) was read as `ifcPath`,
      // and `createHeadlessContext('de')` threw ENOENT before this resolved.
      await expect(idsCommand(['--locale', 'de', PASS_IFC, PASS_IDS])).resolves.toBeUndefined();
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('pin: --locale after the positionals still works (no regression)', async () => {
    silenceOutput();
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      await expect(idsCommand([PASS_IFC, PASS_IDS, '--locale', 'de'])).resolves.toBeUndefined();
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('pin: no flags at all still works', async () => {
    silenceOutput();
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      await expect(idsCommand([PASS_IFC, PASS_IDS])).resolves.toBeUndefined();
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
