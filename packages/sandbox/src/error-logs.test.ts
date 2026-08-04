/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression tests for a caught `ScriptError` losing its logs (#2092).
 *
 * `eval()` clears the sandbox's log buffer in place at the start of every run,
 * so a `ScriptError` that stored that same array by reference had its logs
 * emptied retroactively by the next `eval()` — after the embedder had already
 * inspected them.
 *
 * The scripts here fail with a plain `throw`, never a resource limit, so no
 * test in this file can abort the shared WASM module.
 */

import { describe, expect, it } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { createSandbox, ScriptError, type Sandbox } from './sandbox.js';

/** The scripts under test never touch `bim`, so an empty context suffices. */
const EMPTY_SDK = {} as unknown as BimContext;

/** Runs `script` and returns the `ScriptError` it must reject with. */
async function evalScriptError(sandbox: Sandbox, script: string): Promise<ScriptError> {
  try {
    const result = await sandbox.eval(script, { typescript: false });
    throw new Error(`expected a ScriptError, but eval resolved with ${JSON.stringify(result.value)}`);
  } catch (err) {
    expect(err).toBeInstanceOf(ScriptError);
    return err as ScriptError;
  }
}

/** Flattens a log entry's arguments so assertions read like the console call. */
function logArgs(err: ScriptError): unknown[][] {
  return err.logs.map((entry) => entry.args);
}

describe('ScriptError logs', () => {
  it('captures the logs written before the throw', async () => {
    const sandbox = await createSandbox(EMPTY_SDK);
    try {
      const err = await evalScriptError(
        sandbox,
        'console.log("from first eval"); throw new Error("boom");',
      );

      expect(err.message).toBe('boom');
      expect(logArgs(err)).toEqual([['from first eval']]);
    } finally {
      sandbox.dispose();
    }
  }, 30_000);

  it('keeps a caught error\'s logs after a later eval clears the buffer', async () => {
    const sandbox = await createSandbox(EMPTY_SDK);
    try {
      const err = await evalScriptError(
        sandbox,
        'console.log("from first eval"); throw new Error("boom");',
      );
      expect(logArgs(err)).toEqual([['from first eval']]);

      await sandbox.eval('1;', { typescript: false });

      expect(logArgs(err)).toEqual([['from first eval']]);
    } finally {
      sandbox.dispose();
    }
  }, 30_000);

  it('keeps two caught errors\' logs independent of each other', async () => {
    const sandbox = await createSandbox(EMPTY_SDK);
    try {
      const first = await evalScriptError(
        sandbox,
        'console.log("first"); throw new Error("boom 1");',
      );
      const second = await evalScriptError(
        sandbox,
        'console.log("second"); throw new Error("boom 2");',
      );

      expect(logArgs(first)).toEqual([['first']]);
      expect(logArgs(second)).toEqual([['second']]);
    } finally {
      sandbox.dispose();
    }
  }, 30_000);
});

describe('ScriptResult logs', () => {
  it('returns the logs a successful eval wrote', async () => {
    const sandbox = await createSandbox(EMPTY_SDK);
    try {
      const result = await sandbox.eval('console.log("ok"); 42;', { typescript: false });

      expect(result.value).toBe(42);
      expect(result.logs.map((entry) => entry.args)).toEqual([['ok']]);
    } finally {
      sandbox.dispose();
    }
  }, 30_000);

  it('does not leak one eval\'s logs into the next result', async () => {
    const sandbox = await createSandbox(EMPTY_SDK);
    try {
      const first = await sandbox.eval('console.log("first"); 1;', { typescript: false });
      const second = await sandbox.eval('console.log("second"); 2;', { typescript: false });

      expect(first.logs.map((entry) => entry.args)).toEqual([['first']]);
      expect(second.logs.map((entry) => entry.args)).toEqual([['second']]);
    } finally {
      sandbox.dispose();
    }
  }, 30_000);
});
