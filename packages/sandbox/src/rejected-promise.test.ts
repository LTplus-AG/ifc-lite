/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression tests for a script that hands back a rejected promise.
 *
 * The extension host wraps an entry file as `return activate(ctx)`, so when
 * the entry is `async` the eval value IS the promise. A throw after its first
 * `await` settles that promise as rejected without ever touching
 * `result.error` — `vm.dump` then renders the rejection as ordinary data
 * (`{ type: 'rejected', … }`) and the run reported a clean pass carrying a
 * failure. `executePendingJobs()` cannot close this: it documents that it
 * does not return errors thrown inside async functions or rejected promises.
 *
 * These tests drive the real `createSandbox`.
 *
 * Kept in its own file so vitest gives it a fresh worker — a WASM abort in a
 * neighbouring sandbox test poisons the shared module for the rest of the
 * process (see dispose-leak.test.ts, timeout-interrupt.test.ts).
 */

import { describe, expect, it } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { createSandbox, ScriptError } from './sandbox.js';

/** The scripts under test never touch `bim`, so an empty context suffices. */
const EMPTY_SDK = {} as unknown as BimContext;

/**
 * The shape `wrapEntrySource` produces: the entry's promise is returned, so
 * it lands in the eval result.
 */
function wrapEntry(body: string): string {
  return `;(() => { async function activate() { ${body} } if (typeof activate === 'function') { return activate(); } })()`;
}

describe('sandbox rejected promise', () => {
  it('reports a rejection thrown after the first await as a ScriptError', async () => {
    const sandbox = await createSandbox(EMPTY_SDK, { limits: { timeoutMs: 5_000 } });
    try {
      // A non-allocating throw: no `new Error`, so the failure cannot be
      // confused with a memory-limit abort.
      await expect(
        sandbox.eval(wrapEntry("await 0; throw 'boom';"), { typescript: false }),
      ).rejects.toThrow(ScriptError);
    } finally {
      sandbox.dispose();
    }
  }, 30_000);

  it('reports the rejection reason as the message, like a main-body throw', async () => {
    const sandbox = await createSandbox(EMPTY_SDK, { limits: { timeoutMs: 5_000 } });
    try {
      const fromJob = await sandbox
        .eval(wrapEntry("await 0; throw 'boom';"), { typescript: false })
        .then(
          (ok) => `resolved with ${JSON.stringify(ok.value)}`,
          (err: unknown) => (err as ScriptError).message,
        );
      // The main body raising the same value is the reference report.
      const fromMainBody = await sandbox.eval("throw 'boom';", { typescript: false }).then(
        (ok) => `resolved with ${JSON.stringify(ok.value)}`,
        (err: unknown) => (err as ScriptError).message,
      );

      expect(fromJob).toBe('boom');
      expect(fromJob).toBe(fromMainBody);
    } finally {
      sandbox.dispose();
    }
  }, 30_000);

  it('carries the logs and duration a main-body error carries', async () => {
    const sandbox = await createSandbox(EMPTY_SDK, { limits: { timeoutMs: 5_000 } });
    try {
      await sandbox
        .eval(wrapEntry("console.log('before'); await 0; throw 'boom';"), { typescript: false })
        .then(
          () => {
            throw new Error('expected a rejection');
          },
          (err: unknown) => {
            expect(err).toBeInstanceOf(ScriptError);
            const scriptErr = err as ScriptError;
            expect(scriptErr.logs.map((entry) => entry.args[0])).toEqual(['before']);
            expect(typeof scriptErr.durationMs).toBe('number');
          },
        );
    } finally {
      sandbox.dispose();
    }
  }, 30_000);

  it('still resolves when the returned promise fulfils, and frees its handles', async () => {
    const sandbox = await createSandbox(EMPTY_SDK, { limits: { timeoutMs: 5_000 } });
    try {
      // `ran` proves the job really was drained rather than skipped — the
      // value assertion below would hold even for a no-op job without it.
      // The fulfilment value is an *object* on purpose: only a JSObject lands
      // on the runtime's GC list, so only an object makes the dispose oracle
      // below able to see a leaked settled-value handle.
      const result = await sandbox.eval(
        `let ran = false; ${wrapEntry('await 0; ran = true; return { ok: true };')}`,
        { typescript: false },
      );
      expect(result.value).toEqual({ type: 'fulfilled', value: { ok: true } });

      const ran = await sandbox.eval('ran', { typescript: false });
      expect(ran.value).toBe(true);
    } finally {
      // The leak oracle from dispose-leak.test.ts: a handle left alive keeps a
      // JSObject on the GC list and makes this abort the WASM module (#1905).
      expect(() => sandbox.dispose()).not.toThrow();
    }
  }, 30_000);

  it('still resolves when a completed job leaves a non-promise value', async () => {
    const sandbox = await createSandbox(EMPTY_SDK, { limits: { timeoutMs: 5_000 } });
    try {
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

  it('still reports a main-body throw unchanged', async () => {
    const sandbox = await createSandbox(EMPTY_SDK, { limits: { timeoutMs: 5_000 } });
    try {
      await expect(sandbox.eval("throw new Error('main');", { typescript: false })).rejects.toThrow(
        'main',
      );
    } finally {
      sandbox.dispose();
    }
  }, 30_000);

  it('does not carry a rejection over to the next eval, and frees its handles', async () => {
    const sandbox = await createSandbox(EMPTY_SDK, { limits: { timeoutMs: 5_000 } });
    try {
      // An *object* rejection reason for the same reason as above: only a
      // JSObject on the GC list makes a leaked error handle visible to the
      // dispose oracle.
      await expect(
        sandbox.eval(wrapEntry("await 0; throw { code: 'boom' };"), { typescript: false }),
      ).rejects.toThrow(ScriptError);

      const result = await sandbox.eval("'fine'", { typescript: false });
      expect(result.value).toBe('fine');
    } finally {
      // A leaked handle from the failure branch would keep a JSObject on the
      // runtime's GC list and make this dispose abort the WASM module (#1905).
      expect(() => sandbox.dispose()).not.toThrow();
    }
  }, 30_000);
});
