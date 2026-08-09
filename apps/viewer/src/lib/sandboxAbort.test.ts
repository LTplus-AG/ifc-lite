/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reactive half of #1922 containment: the app must actually read the latch
 * (`isSandboxRuntimeAborted()`) and a caught `SandboxAbortError`, and turn
 * either into the "reload the page" message — not a generic script error.
 *
 * `describeSandboxAbort` takes the aborted flag as a plain boolean rather
 * than reading `isSandboxRuntimeAborted()` itself, so these tests set the
 * latched state up directly instead of reproducing the upstream OOM.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SandboxAbortError } from '@ifc-lite/sandbox';
import { describeSandboxAbort, SANDBOX_ABORT_RELOAD_MESSAGE } from './sandboxAbort.js';

describe('describeSandboxAbort', () => {
  it('returns the reload message when the runtime is already latched aborted, before any attempt', () => {
    assert.equal(describeSandboxAbort(true), SANDBOX_ABORT_RELOAD_MESSAGE);
  });

  it('returns the reload message for a SandboxAbortError caught mid-attempt, even if not latched going in', () => {
    const err = new SandboxAbortError(new Error('Aborted(Assertion failed: list_empty(&rt->gc_obj_list))'));
    assert.equal(describeSandboxAbort(false, err), SANDBOX_ABORT_RELOAD_MESSAGE);
  });

  it('leaves an ordinary script error alone on a healthy runtime', () => {
    assert.equal(
      describeSandboxAbort(false, new Error("'foo' is not defined")),
      null,
    );
  });
});
