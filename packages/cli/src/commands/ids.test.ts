/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite ids --json` exit-code contract.
 *
 * The human-readable path has always set `process.exitCode` from
 * `summary.failedSpecifications` so a CI step piping through this command
 * fails when the model fails IDS validation. The `--json` path returned
 * right after `printJson(...)` without ever touching `process.exitCode` --
 * a script driving this command with `--json` (the shape any script would
 * actually parse) saw a clean exit 0 even when every specification failed.
 * Proven by direct invocation: `ifc-lite ids <fail-fixture> --json` exited 0
 * while the same fixture without `--json` exited 1.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { idsCommand } from './ids.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpus = resolve(here, '../../../ids/src/__corpus__/buildingsmart-ids/classification');
const FAIL_IFC = resolve(corpus, 'fail-systems_should_match_exactly_2_5.ifc');
const FAIL_IDS = resolve(corpus, 'fail-systems_should_match_exactly_2_5.ids');
const PASS_IFC = resolve(corpus, 'pass-systems_should_match_exactly_1_5.ifc');
const PASS_IDS = resolve(corpus, 'pass-systems_should_match_exactly_1_5.ids');

function silenceOutput() {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('idsCommand --json exit code', () => {
  it('sets a non-zero exit code when the JSON report contains a failed specification', async () => {
    silenceOutput();
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      await idsCommand([FAIL_IFC, FAIL_IDS, '--json']);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('leaves the exit code at 0 for a fully passing --json run', async () => {
    silenceOutput();
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      await idsCommand([PASS_IFC, PASS_IDS, '--json']);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('agrees with the non-JSON path on the same failing input', async () => {
    silenceOutput();
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = 0;
      await idsCommand([FAIL_IFC, FAIL_IDS]);
      const humanExit = process.exitCode;

      process.exitCode = 0;
      await idsCommand([FAIL_IFC, FAIL_IDS, '--json']);
      const jsonExit = process.exitCode;

      expect(jsonExit).toBe(humanExit);
      expect(jsonExit).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
