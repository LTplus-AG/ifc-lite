/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Containment for the upstream teardown abort (#1922).
 *
 * An out-of-memory raised inside a *drained promise job* — the reported case
 * is the post-`await` body of an `async function run()` — leaves objects
 * orphaned on `rt->gc_obj_list` with leaked refcounts. Upstream
 * `JS_FreeRuntime` asserts that list is empty, so `runtime.dispose()` comes
 * back as an emscripten abort. `eval()` resolves normally; the damage only
 * surfaces at teardown.
 *
 * The abort itself is not fixable from here — see `SandboxAbortError` for the
 * remedies that were measured and rejected. What this pins is the containment:
 * the failure is reported as a named error that says what happened and which
 * issue it is, the sandbox reads as disposed rather than half-alive, and the
 * process records that an abort happened at all.
 *
 * Surviving it — retiring the poisoned WASM module so the next sandbox is
 * built on a fresh one — is pinned separately, in `module-recovery.test.ts`.
 *
 * IMPORTANT — test order in this file is load-bearing. Emscripten latches its
 * `ABORT` flag per module instance, so the first abort on a given module is
 * the only one that throws. The healthy-path test therefore runs first, and no
 * test after the reproducer may assume a throwing teardown. The file is kept
 * separate so vitest gives it a dedicated worker.
 */

import { describe, expect, it } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import {
  createSandbox,
  isSandboxRuntimeAborted,
  Sandbox,
  SandboxAbortError,
} from './sandbox.js';

/** The #1922 reproducer verbatim: OOM inside the post-await body of a job. */
const OOM_IN_JOB =
  'async function run() { await 0; const a = []; for (;;) { a.push({ k: "v" }); } } run(); "started"';

describe('sandbox teardown after an OOM inside a drained job (#1922)', () => {
  it('leaves a healthy sandbox untouched', async () => {
    // Runs first, before any abort has latched: proves the flag and the error
    // wrapping are not set by ordinary use.
    expect(isSandboxRuntimeAborted()).toBe(false);
    const sandbox: Sandbox = await createSandbox({} as BimContext);
    const result = await sandbox.eval('1 + 1', { typescript: false });
    expect(result.value).toBe(2);

    expect(sandbox.disposed).toBe(false);
    expect(() => sandbox.dispose()).not.toThrow();
    expect(sandbox.disposed).toBe(true);
    expect(isSandboxRuntimeAborted()).toBe(false);
  }, 60000);

  it('rejects eval on a disposed sandbox with a message that says so', async () => {
    // Before the fix this reported "Sandbox not initialized. Call init()
    // first." — advice that cannot work, because a disposed sandbox is not
    // re-initializable.
    const sandbox = await createSandbox({} as BimContext);
    sandbox.dispose();
    await expect(sandbox.eval('1 + 1', { typescript: false })).rejects.toThrow(/disposed/i);
  }, 60000);

  it('reports the abort as a named error naming the issue', async () => {
    const sandbox = await createSandbox({} as BimContext, {
      limits: { memoryBytes: 8 * 1024 * 1024 },
    });
    // The defect in one line: the run that breaks teardown resolves normally.
    const result = await sandbox.eval(OOM_IN_JOB, { typescript: false });
    expect(result.value).toBe('started');

    let caught: unknown;
    try {
      sandbox.dispose();
    } catch (err) {
      caught = err;
    }

    // Upstream fixing the abort must not fail this file, so the assertion is
    // conditional on it firing at all — but if it fires, it must arrive
    // contained rather than as a raw emscripten assertion.
    if (caught !== undefined) {
      expect(caught).toBeInstanceOf(SandboxAbortError);
      expect((caught as Error).message).toMatch(/1922/);
      expect((caught as Error).message).toMatch(/drained promise job/);
      expect((caught as SandboxAbortError).cause).toBeDefined();
      expect(isSandboxRuntimeAborted()).toBe(true);
    }

    // Either way the sandbox is off: teardown is never retried against
    // half-freed structures, and reuse fails loudly.
    expect(sandbox.disposed).toBe(true);
    expect(() => sandbox.dispose()).not.toThrow();
    await expect(sandbox.eval('1 + 1', { typescript: false })).rejects.toThrow(/disposed/i);
  }, 60000);

  it('keeps the process flag set across a second abort', async () => {
    // The flag is latched: once an abort has happened in this process it stays
    // observable, whatever the second teardown does. Whether that teardown
    // throws depends on which module it ran on — emscripten's latch is per
    // module instance, and `module-recovery.test.ts` is where that is pinned —
    // so this asserts only the part that holds either way.
    const sandbox = await createSandbox({} as BimContext, {
      limits: { memoryBytes: 8 * 1024 * 1024 },
    });
    await sandbox.eval(OOM_IN_JOB, { typescript: false });
    let caught: unknown;
    try {
      sandbox.dispose();
    } catch (err) {
      caught = err;
    }
    // Whether this throws at all is upstream's business, but if it does throw
    // it must still arrive contained, not as a raw emscripten assertion. Bound
    // rather than discarded (AGENTS.md: no silent `catch {}`).
    if (caught !== undefined) expect(caught).toBeInstanceOf(SandboxAbortError);
    expect(isSandboxRuntimeAborted()).toBe(true);
  }, 60000);
});
