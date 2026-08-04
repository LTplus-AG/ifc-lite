/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression test for the double-free reachable from the upstream
 * `JS_FreeRuntime` abort (#1922).
 *
 * An out-of-memory (or CPU-interrupt) exception raised inside a drained
 * promise job leaves QuickJS holding objects with leaked refcounts. Upstream
 * `JS_FreeRuntime` then trips `assert(list_empty(&rt->gc_obj_list))` and
 * throws out of `runtime.dispose()` part-way through freeing the runtime. That
 * abort is upstream and we cannot prevent it — but `Sandbox.dispose()` must
 * not leave the runtime handle in place afterwards, because every later
 * `dispose()` (a React cleanup, an extension unload, a defensive re-dispose)
 * would then free the same half-freed structures again.
 *
 * This file is kept separate so vitest gives it its own worker: the abort
 * poisons the shared WASM module for every later test in the same process.
 */

import { describe, expect, it } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { createSandbox } from './sandbox.js';

/**
 * Exhausts the 64 MB default budget from inside a job. `eval()` resolves with
 * `"started"` — the rejection is invisible to the host — and the damage only
 * shows up at teardown.
 */
const OOM_IN_JOB = 'async function run() { await 0; new Array(1e9).fill(0); } run(); "started"';

describe('sandbox dispose after an OOM inside a drained job (#1922)', () => {
  it('does not re-enter runtime teardown after a failed dispose', async () => {
    const sandbox = await createSandbox({} as BimContext);
    await sandbox.eval(OOM_IN_JOB, { typescript: false });

    // The first dispose() surfaces whatever upstream does. Today that is the
    // `JS_FreeRuntime` abort; if upstream ever fixes it, this is simply clean.
    // Bound and logged rather than swallowed (AGENTS.md house rule): the throw
    // is expected here by design — see `Sandbox.dispose()` — but if upstream
    // ever fixes the abort, or it becomes a different error, a silent catch
    // would hide that transition while this makes it visible in the run output.
    let firstDisposeError: unknown;
    try {
      sandbox.dispose();
    } catch (err) {
      firstDisposeError = err;
      console.info('[dispose-abort] first dispose() threw as expected:', err);
    }
    // Not asserted to be non-undefined: upstream fixing the abort must not
    // fail this test, whose subject is the second and third calls.
    void firstDisposeError;

    // Whatever happened, the runtime handle is gone: teardown is not retried.
    expect(() => sandbox.dispose()).not.toThrow();
    expect(() => sandbox.dispose()).not.toThrow();
  });
});
