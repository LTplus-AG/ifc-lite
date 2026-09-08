/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression tests for the silently-swallowed CPU timeout.
 *
 * QuickJS surfaces an interrupted *main body* as an eval error, so a script
 * that spins in its top level already fails with `interrupted`. A script that
 * spins inside an `async` body runs as a *promise job*, and
 * `executePendingJobs()` reports no error when the interrupt handler cuts one
 * short — so `eval()` used to return the pre-job main-body value and report
 * success, handing the caller a silently truncated run.
 *
 * These tests drive the real `createSandbox` with a short `timeoutMs`.
 *
 * This file is kept separate so vitest gives it its own worker: an interrupt
 * abort poisons the shared WASM module for every later test in the process.
 */

import { describe, expect, it } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { createSandbox, ScriptError } from './sandbox.js';

/** The scripts under test never touch `bim`, so an empty context suffices. */
const EMPTY_SDK = {} as unknown as BimContext;

/** Busy-spins without allocating — the CPU deadline is the only way out. */
const SPIN = 'let n = 0; while (true) { n += 1; }';

/** Runs `script` and returns the rejection, failing if it resolves instead. */
async function evalRejection(script: string, timeoutMs: number): Promise<unknown> {
  const sandbox = await createSandbox(EMPTY_SDK, { limits: { timeoutMs } });
  try {
    const result = await sandbox.eval(script, { typescript: false });
    throw new Error(`expected a timeout, but eval resolved with ${JSON.stringify(result.value)}`);
  } catch (err) {
    return err;
  } finally {
    sandbox.dispose();
  }
}

describe('sandbox CPU timeout', () => {
  it('reports a main-body timeout as an interrupted error', async () => {
    const err = await evalRejection(`${SPIN} 'unreached'`, 200);

    expect(err).toBeInstanceOf(ScriptError);
    expect((err as ScriptError).message).toBe('interrupted');
  }, 30_000);

  it('reports a timeout inside a drained promise job the same way', async () => {
    const err = await evalRejection(
      `async function run() { await 0; ${SPIN} } run(); 'started'`,
      200,
    );

    expect(err).toBeInstanceOf(ScriptError);
    expect((err as ScriptError).message).toBe('interrupted');
  }, 30_000);

  it('reports an interrupted entry-shaped promise as a timeout', async () => {
    // The extension host's wrap returns the entry's promise, so a deadline hit
    // inside it settles that promise as rejected. The interrupt flag is checked
    // before the rejected-promise path (#2077) so this stays a timeout report.
    const err = await evalRejection(
      `;(() => { async function activate() { await 0; ${SPIN} } return activate(); })()`,
      200,
    );

    expect(err).toBeInstanceOf(ScriptError);
    expect((err as ScriptError).message).toBe('interrupted');
  }, 30_000);

  it('still returns the main-body value when the jobs complete', async () => {
    const sandbox = await createSandbox(EMPTY_SDK, { limits: { timeoutMs: 5_000 } });
    try {
      // `ran` proves the job really was drained rather than skipped — the
      // assertion would hold even for a no-op job without it.
      const result = await sandbox.eval(
        "let ran = false; async function run() { await 0; ran = true; } run(); 'started'",
        { typescript: false },
      );
      expect(result.value).toBe('started');

      const ran = await sandbox.eval('ran', { typescript: false });
      expect(ran.value).toBe(true);
    } finally {
      sandbox.dispose();
    }
  }, 30_000);

  it('does not carry a timeout over to the next eval', async () => {
    const sandbox = await createSandbox(EMPTY_SDK, { limits: { timeoutMs: 200 } });
    try {
      await expect(sandbox.eval(SPIN, { typescript: false })).rejects.toThrow(ScriptError);

      const result = await sandbox.eval("'fine'", { typescript: false });
      expect(result.value).toBe('fine');
    } finally {
      sandbox.dispose();
    }
  }, 30_000);
});
