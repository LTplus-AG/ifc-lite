/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { INSTANCE_ANCHOR_HIGH_OFFSET } from './instanced-render.js';
import { uploadInstancedRteDeltas } from './instanced-rte.js';
import { rteRelativePositionF32 } from './relative-to-eye.js';

describe('instanced RTE submission deltas (#5049)', () => {
  it('preserves Astra’s 15.625 mm national-grid witness through the instance record', () => {
    const writes: Array<{ offset: number; data: Float32Array }> = [];
    const device = {
      queue: {
        writeBuffer: (_buffer: GPUBuffer, offset: number, data: ArrayBufferView) => {
          writes.push({ offset, data: new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) });
        },
      },
    } as unknown as GPUDevice;
    uploadInstancedRteDeltas(device, [{
      instanceBuffer: {} as GPUBuffer,
      instanceCount: 1,
      canonicalAnchors: new Float64Array([5_000_000.015625, -2, 4]),
    }], [5_000_000, -2, 4]);

    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.offset, INSTANCE_ANCHOR_HIGH_OFFSET);
    const relative = rteRelativePositionF32([0, 0, 0], writes[0]!.data);
    assert.ok(Math.abs(relative[0] - 0.015625) < 1e-8, `lost source residual: ${relative[0]}`);
  });

  it('enforces the same source and camera-relative envelopes for every pass', () => {
    const device = { queue: { writeBuffer() { throw new Error('must not upload rejected data'); } } } as unknown as GPUDevice;
    assert.throws(() => uploadInstancedRteDeltas(device, [{
      instanceBuffer: {} as GPUBuffer,
      instanceCount: 1,
      canonicalAnchors: new Float64Array([1_000_000_001, 0, 0]),
    }], [1_000_000_001, 0, 0]), /source envelope/);
    assert.throws(() => uploadInstancedRteDeltas(device, [{
      instanceBuffer: {} as GPUBuffer,
      instanceCount: 1,
      canonicalAnchors: new Float64Array([0, 0, 0]),
    }], [1_000_000_001, 0, 0]), /source envelope/);
    assert.throws(() => uploadInstancedRteDeltas(device, [{
      instanceBuffer: {} as GPUBuffer,
      instanceCount: 1,
      canonicalAnchors: new Float64Array([2_000_000, 0, 0]),
    }], [0, 0, 0]), /camera-relative envelope/);
  });
});
