/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The extension host's sandbox handle must read #1922 containment too — see
 * `../../lib/sandboxAbort.test.ts` for the pure decision logic. This pins the
 * wiring: `run()` turns a caught `SandboxAbortError` into the reload
 * message instead of passing the raw teardown-abort text through.
 *
 * `sandbox.eval` is faked to throw directly — no WASM, no real OOM — so this
 * is about how `BimSandboxHandle.run()` reacts to the latched failure, not
 * about reproducing the upstream abort.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Sandbox } from '@ifc-lite/sandbox';
import { SandboxAbortError } from '@ifc-lite/sandbox';
import { SANDBOX_ABORT_RELOAD_MESSAGE } from '../../lib/sandboxAbort.js';
import { BimSandboxHandle } from './sandbox-factory.js';

function fakeSandbox(evalImpl: () => Promise<never>): Sandbox {
  return {
    eval: evalImpl,
    dispose: () => {},
  } as unknown as Sandbox;
}

describe('BimSandboxHandle.run', () => {
  it('reports the reload message when eval() throws SandboxAbortError, not the raw teardown text', async () => {
    const sandbox = fakeSandbox(async () => {
      throw new SandboxAbortError(new Error('Aborted(Assertion failed: list_empty(&rt->gc_obj_list))'));
    });
    const handle = new BimSandboxHandle(sandbox);

    await assert.rejects(
      () => handle.run('1 + 1'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, SANDBOX_ABORT_RELOAD_MESSAGE);
        return true;
      },
    );
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
