/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reactive half of #1922 handling: the app must recognise a caught
 * `SandboxAbortError` and turn it into the abort message rather than a generic
 * script error — and must NOT claim a page reload is needed, because the
 * package now retires the aborted WASM module and builds the next sandbox on a
 * fresh one.
 *
 * `describeSandboxAbort` inspects the caught error only, so these tests
 * construct the failure directly instead of reproducing the upstream OOM.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Sandbox } from '@ifc-lite/sandbox';
import { SandboxAbortError } from '@ifc-lite/sandbox';
import {
  describeSandboxAbort,
  disposeSandboxReportingAbort,
  SANDBOX_ABORT_MESSAGE,
  SANDBOX_MODULE_RETIRED_MESSAGE,
} from './sandboxAbort.js';

describe('describeSandboxAbort', () => {
  it('returns the abort message for a SandboxAbortError', () => {
    const err = new SandboxAbortError(new Error('Aborted(Assertion failed: list_empty(&rt->gc_obj_list))'));
    assert.equal(describeSandboxAbort(err), SANDBOX_ABORT_MESSAGE);
  });

  it('leaves an ordinary script error alone', () => {
    assert.equal(describeSandboxAbort(new Error("'foo' is not defined")), null);
  });

  it('treats a clean teardown (no error) as no abort', () => {
    assert.equal(describeSandboxAbort(null), null);
    assert.equal(describeSandboxAbort(undefined), null);
  });

  it('does not tell the user to reload - recovery is automatic', () => {
    // The behaviour change this issue turns on. Both messages describe a
    // failure the user can retry past; advising a reload would be wrong now
    // and was the user-visible symptom in #1922.
    for (const message of [SANDBOX_ABORT_MESSAGE, SANDBOX_MODULE_RETIRED_MESSAGE]) {
      assert.equal(/reload the page/i.test(message), false, message);
      assert.equal(/run again/i.test(message), true, message);
      assert.equal(/no reload needed/i.test(message), true, message);
    }
  });
});

describe('disposeSandboxReportingAbort', () => {
  function fakeSandbox(dispose: () => void): Sandbox {
    return { dispose } as unknown as Sandbox;
  }

  it('surfaces a teardown abort as a message, because the run itself resolved clean', () => {
    // The #1922 shape: eval() returned "started", so this is the only place
    // the viewer can learn the script actually died.
    const message = disposeSandboxReportingAbort(
      fakeSandbox(() => {
        throw new SandboxAbortError(new Error('Aborted(Assertion failed: list_empty(&rt->gc_obj_list))'));
      }),
    );
    assert.equal(message, SANDBOX_ABORT_MESSAGE);
  });

  it('reports nothing for a clean teardown', () => {
    let disposed = false;
    assert.equal(disposeSandboxReportingAbort(fakeSandbox(() => { disposed = true; })), null);
    assert.equal(disposed, true);
  });

  it('swallows an unrelated teardown failure rather than escaping a finally or an unmount', () => {
    assert.equal(
      disposeSandboxReportingAbort(fakeSandbox(() => { throw new Error('Lifetime not alive'); })),
      null,
    );
  });
});
