/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `init()` must refuse a disposed sandbox (#1922 follow-up).
 *
 * `init()` awaits the shared WASM module before it allocates anything, which
 * is the same shape as the transpile await in `runEval`: a `dispose()` landing
 * in that window — a React cleanup firing while `createSandbox()` is still in
 * flight is the ordinary way it happens — used to be invisible to the code
 * that resumed after it. `init()` then built a runtime, a context and a bridge
 * on a sandbox that already read as disposed, so nothing would ever run in
 * them and no later `dispose()` was owed: the WASM runtime stayed allocated
 * for the lifetime of the page or process.
 *
 * The same guard covers the plainer case of calling `init()` after
 * `dispose()`. A disposed sandbox is not re-initializable, so it has to say so
 * rather than hand back a realm `eval()` will refuse to use.
 */

import { describe, expect, it } from 'vitest';
import type { BimContext } from '@ifc-lite/sdk';
import { Sandbox } from './sandbox.js';

const EMPTY_SDK = {} as unknown as BimContext;

describe('Sandbox.init after disposal', () => {
  it('rejects a dispose that lands during the module await', async () => {
    const sandbox = new Sandbox(EMPTY_SDK);
    // `init()` suspends on `await getModule()` before it touches the module,
    // so a synchronous dispose() here always lands inside that window —
    // whether or not the module promise has already resolved.
    const pending = sandbox.init();
    sandbox.dispose();

    await expect(pending).rejects.toThrow(/Sandbox disposed/);
    expect(sandbox.disposed).toBe(true);
    // Nothing was allocated after the disposal, so there is nothing left to
    // free: a second dispose() is a no-op rather than a second teardown.
    expect(() => sandbox.dispose()).not.toThrow();
    await expect(sandbox.eval('1 + 1', { typescript: false })).rejects.toThrow(/Sandbox disposed/);
  }, 60000);

  it('rejects an init() called after dispose()', async () => {
    const sandbox = new Sandbox(EMPTY_SDK);
    await sandbox.init();
    expect((await sandbox.eval('1 + 1', { typescript: false })).value).toBe(2);
    sandbox.dispose();

    await expect(sandbox.init()).rejects.toThrow(/Sandbox disposed/);
    expect(sandbox.disposed).toBe(true);
    await expect(sandbox.eval('1 + 1', { typescript: false })).rejects.toThrow(/Sandbox disposed/);
  }, 60000);
});
