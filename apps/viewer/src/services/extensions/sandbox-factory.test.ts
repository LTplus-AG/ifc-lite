/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The extension host's sandbox handle must react to #1922 — see
 * `../../lib/sandboxAbort.test.ts` for the pure decision logic. This pins the
 * wiring: `run()` turns a caught `SandboxAbortError` into the abort message
 * instead of passing the raw teardown text through, and refuses to run a
 * sandbox whose WASM module was retired, discarding it so the runtime
 * reactivates on a fresh one.
 *
 * `sandbox` is faked — no WASM, no real OOM — so this is about how
 * `BimSandboxHandle` reacts to the conditions, not about reproducing the
 * upstream abort. `packages/sandbox/src/module-recovery.test.ts` drives the
 * real module for that.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Sandbox } from '@ifc-lite/sandbox';
import { SandboxAbortError } from '@ifc-lite/sandbox';
import { SANDBOX_ABORT_MESSAGE, SANDBOX_MODULE_RETIRED_MESSAGE } from '../../lib/sandboxAbort.js';
import { BimSandboxHandle } from './sandbox-factory.js';

function fakeSandbox(
  evalImpl: () => Promise<unknown>,
  extra: { moduleRetired?: boolean; dispose?: () => void } = {},
): Sandbox {
  return {
    eval: evalImpl,
    moduleRetired: extra.moduleRetired ?? false,
    dispose: extra.dispose ?? (() => {}),
  } as unknown as Sandbox;
}

describe('BimSandboxHandle.run', () => {
  it('reports the abort message when eval() throws SandboxAbortError, not the raw teardown text', async () => {
    const sandbox = fakeSandbox(async () => {
      throw new SandboxAbortError(new Error('Aborted(Assertion failed: list_empty(&rt->gc_obj_list))'));
    });
    const handle = new BimSandboxHandle(sandbox);

    await assert.rejects(
      () => handle.run('1 + 1'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, SANDBOX_ABORT_MESSAGE);
        return true;
      },
    );
    // The sandbox died with the abort, so the handle must read as disposed and
    // the runtime reactivate rather than keep calling into a dead realm.
    assert.equal(handle.isDisposed, true);
  });

  it('discards a sandbox whose WASM module was retired instead of running on it', async () => {
    let evalCalls = 0;
    let disposed = false;
    const sandbox = fakeSandbox(
      async () => {
        evalCalls += 1;
        return { value: 1, logs: [], durationMs: 0 };
      },
      { moduleRetired: true, dispose: () => { disposed = true; } },
    );
    const handle = new BimSandboxHandle(sandbox);

    await assert.rejects(
      () => handle.run('1 + 1'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, SANDBOX_MODULE_RETIRED_MESSAGE);
        return true;
      },
    );
    assert.equal(evalCalls, 0, 'must not run against a retired module');
    assert.equal(disposed, true, 'the doomed sandbox must be torn down');
    assert.equal(handle.isDisposed, true);
  });

  it('still runs on a healthy sandbox', async () => {
    const sandbox = fakeSandbox(async () => ({ value: 2, logs: [], durationMs: 1 }));
    const handle = new BimSandboxHandle(sandbox);
    const result = await handle.run('1 + 1');
    assert.equal(result.value, 2);
    assert.equal(handle.isDisposed, false);
  });

  it('leaves an ordinary eval failure untouched', async () => {
    const sandbox = fakeSandbox(async () => {
      throw new Error("'foo' is not defined");
    });
    const handle = new BimSandboxHandle(sandbox);

    await assert.rejects(
      () => handle.run('foo'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "'foo' is not defined");
        return true;
      },
    );
  });
});
