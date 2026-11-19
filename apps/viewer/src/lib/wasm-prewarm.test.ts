/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { scheduleFastPath, scheduleWasmPrewarm, shouldSkipPrewarm } from './wasm-prewarm.js';

/**
 * The prewarm speculatively downloads the ~1.3 MB engine binary for a user who
 * may never open a model, so the affordability gate is the whole safety story:
 * an over-eager `false` spends a metered data plan, an over-cautious `true`
 * gives back the cold-start win on the connections that need it most.
 */
describe('shouldSkipPrewarm', () => {
  it('prewarms when the browser exposes no NetworkInformation (Safari, Firefox)', () => {
    assert.equal(shouldSkipPrewarm(undefined), false);
  });

  it('prewarms on a normal connection', () => {
    assert.equal(shouldSkipPrewarm({ saveData: false, effectiveType: '4g' }), false);
    assert.equal(shouldSkipPrewarm({ saveData: false, effectiveType: '3g' }), false);
  });

  it('skips when the user asked for reduced data use', () => {
    assert.equal(shouldSkipPrewarm({ saveData: true, effectiveType: '4g' }), true);
  });

  it('skips on 2g-class links, where a speculative 1.3 MB fetch would compete', () => {
    assert.equal(shouldSkipPrewarm({ effectiveType: '2g' }), true);
    assert.equal(shouldSkipPrewarm({ effectiveType: 'slow-2g' }), true);
  });

  it('treats a partial NetworkInformation as affordable rather than guessing', () => {
    assert.equal(shouldSkipPrewarm({}), false);
    assert.equal(shouldSkipPrewarm({ effectiveType: undefined }), false);
  });
});

describe('prewarm without WebAssembly SIMD (#10784)', () => {
  it('downloads nothing the browser cannot compile, and stays eligible', () => {
    const idle = mock.fn((_run: () => void, _opts?: unknown) => 0);
    Object.defineProperty(globalThis, 'window', { value: { requestIdleCallback: idle }, configurable: true });
    const validate = mock.method(WebAssembly, 'validate', () => false);
    try {
      scheduleWasmPrewarm();
      scheduleFastPath();
      assert.equal(idle.mock.callCount(), 0, 'neither the binary prewarm nor the spare workers may be scheduled');
      // The probe is the only thing that stopped them: with SIMD both schedule.
      validate.mock.restore();
      scheduleWasmPrewarm();
      scheduleFastPath();
      assert.equal(idle.mock.callCount(), 2);
    } finally {
      validate.mock.restore();
      Reflect.deleteProperty(globalThis, 'window');
    }
  });
});
