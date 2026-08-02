/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runGpuUpload, resetGpuUploadGuardForTests } from './gpu-upload-guard.js';

// The production failure this contains, verbatim from error tracking.
const GPU_OOM =
  "Failed to execute 'createBuffer' on 'GPUDevice': createBuffer failed, " +
  'size (193836) is too large for the implementation when mappedAtCreation == true';

let warnings: unknown[][] = [];
const realWarn = console.warn;

beforeEach(() => {
  resetGpuUploadGuardForTests();
  warnings = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
});

afterEach(() => {
  console.warn = realWarn;
});

describe('runGpuUpload', () => {
  it('returns the callback value when the upload succeeds', () => {
    assert.equal(runGpuUpload('site', () => 42), 42);
    assert.equal(warnings.length, 0);
  });

  it('does not swallow a falsy-but-real return value', () => {
    // `flushPending` returns a boolean the caller acts on — `false` must stay
    // `false` and must not be confused with the "it threw" signal.
    assert.equal(runGpuUpload('site', () => false), false);
    assert.equal(runGpuUpload('site', () => 0), 0);
  });

  it('contains a throw instead of letting it reach React or the rAF loop', () => {
    const out = runGpuUpload('appendToBatches:non-streaming', () => {
      throw new RangeError(GPU_OOM);
    });
    // undefined, NOT a rethrow: an uncaught throw here unmounts the canvas.
    assert.equal(out, undefined);
  });

  it('keeps running after a failure — one bad batch is not a dead session', () => {
    runGpuUpload('site', () => { throw new Error('boom'); });
    assert.equal(runGpuUpload('site', () => 'still working'), 'still working');
  });

  it('warns once per call site, not once per frame', () => {
    // These failures repeat every frame; unthrottled they flood the console.
    for (let i = 0; i < 50; i++) {
      runGpuUpload('flushPending:raf', () => { throw new Error('boom'); });
    }
    assert.equal(warnings.length, 1);
  });

  it('warns separately for a different call site', () => {
    runGpuUpload('flushPending:raf', () => { throw new Error('boom'); });
    runGpuUpload('rebuildPendingBatches:removals', () => { throw new Error('boom'); });
    assert.equal(warnings.length, 2);
  });

  it('names the failing site in the warning so triage does not need a stack', () => {
    runGpuUpload('rebuildPendingBatches:rotations', () => { throw new Error('boom'); });
    assert.match(String(warnings[0][0]), /rebuildPendingBatches:rotations/);
  });

  it('rethrows nothing even for a non-Error throwable', () => {
    assert.equal(runGpuUpload('site', () => { throw 'a string'; }), undefined);
    assert.equal(runGpuUpload('site', () => { throw null; }), undefined);
  });
});
