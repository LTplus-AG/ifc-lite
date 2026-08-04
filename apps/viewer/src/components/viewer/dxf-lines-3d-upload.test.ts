/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { uploadDxfLines3DGuarded, type DxfLines3DUploadTarget } from './dxf-lines-3d-upload.js';
import { resetGpuUploadGuardForTests } from './gpu-upload-guard.js';

/** Renderer stub that counts calls and can be told to throw on upload. */
function makeRenderer(opts?: { throwOnUpload?: boolean }): DxfLines3DUploadTarget & {
  uploadCount: number;
  clearCount: number;
} {
  const target = {
    uploadCount: 0,
    clearCount: 0,
    uploadDxfLines3D(_vertices: Float32Array): void {
      target.uploadCount += 1;
      if (opts?.throwOnUpload) {
        throw new RangeError(
          "Failed to execute 'createBuffer' on 'GPUDevice': createBuffer failed",
        );
      }
    },
    clearDxfLines3D(): void {
      target.clearCount += 1;
    },
  };
  return target;
}

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

describe('uploadDxfLines3DGuarded', () => {
  it('clears without uploading when the vertex buffer is empty', () => {
    const renderer = makeRenderer();
    uploadDxfLines3DGuarded(renderer, new Float32Array(0));
    assert.equal(renderer.uploadCount, 0);
    assert.equal(renderer.clearCount, 1);
  });

  it('uploads and does not clear on success', () => {
    const renderer = makeRenderer();
    uploadDxfLines3DGuarded(renderer, new Float32Array([0, 0, 0, 1, 0, 0]));
    assert.equal(renderer.uploadCount, 1);
    assert.equal(renderer.clearCount, 0);
    assert.equal(warnings.length, 0);
  });

  it('drops the underlay (clears) instead of propagating when the upload throws', () => {
    const renderer = makeRenderer({ throwOnUpload: true });
    assert.doesNotThrow(() => {
      uploadDxfLines3DGuarded(renderer, new Float32Array([0, 0, 0, 1, 0, 0]));
    });
    assert.equal(renderer.clearCount, 1);
  });

  it('warns once per call site, not once per re-run (render-effect re-execution)', () => {
    const renderer = makeRenderer({ throwOnUpload: true });
    for (let i = 0; i < 25; i++) {
      uploadDxfLines3DGuarded(renderer, new Float32Array([0, 0, 0, 1, 0, 0]));
    }
    assert.equal(renderer.uploadCount, 25);
    assert.equal(renderer.clearCount, 25);
    assert.equal(warnings.length, 1);
  });

  it('a fresh context (guard reset) reports again', () => {
    const renderer = makeRenderer({ throwOnUpload: true });
    uploadDxfLines3DGuarded(renderer, new Float32Array([0, 0, 0, 1, 0, 0]));
    assert.equal(warnings.length, 1);

    // Simulate a fresh session/context (e.g. a new renderer instance after
    // the old device was lost) — the latch must not stay closed forever.
    resetGpuUploadGuardForTests();
    uploadDxfLines3DGuarded(renderer, new Float32Array([0, 0, 0, 1, 0, 0]));
    assert.equal(warnings.length, 2);
  });
});
