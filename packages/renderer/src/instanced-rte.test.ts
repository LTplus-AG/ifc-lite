/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { INSTANCE_ANCHOR_HIGH_OFFSET, INSTANCE_STRIDE_BYTES } from './instanced-render.js';
import { collectInstanceRuns, drawInstanceRuns, uploadInstancedRteDeltas } from './instanced-rte.js';
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

  it('enforces the same source envelope for every pass', () => {
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
  });

  it('skips out-of-envelope instances and returns the drawable runs (#6128)', () => {
    const writes: number[] = [];
    const device = {
      queue: { writeBuffer: (_buffer: GPUBuffer, offset: number) => { writes.push(offset); } },
    } as unknown as GPUDevice;
    const far = 2_000_000;
    const runs = uploadInstancedRteDeltas(device, [
      {
        instanceBuffer: {} as GPUBuffer,
        instanceCount: 6,
        // near, near, FAR, near, FAR, FAR
        canonicalAnchors: new Float64Array([0, 0, 0, 1, 0, 0, far, 0, 0, 2, 0, 0, far, 0, 0, far, 0, 0]),
      },
      { instanceBuffer: {} as GPUBuffer, instanceCount: 1, canonicalAnchors: new Float64Array([far, 0, 0]) },
      { instanceBuffer: {} as GPUBuffer, instanceCount: 2, canonicalAnchors: new Float64Array([0, 0, 0, 0, 0, 1]) },
    ], [0, 0, 0]);

    assert.deepEqual(runs, [
      [{ first: 0, count: 2 }, { first: 3, count: 1 }],
      [],
      [{ first: 0, count: 2 }],
    ]);
    assert.deepEqual(
      writes,
      [0, 1, 3, 0, 1].map((instance) => instance * INSTANCE_STRIDE_BYTES + INSTANCE_ANCHOR_HIGH_OFFSET),
      'a skipped instance is never uploaded',
    );
  });

  it('groups drawable instances into maximal runs, visiting each once', () => {
    const visited: number[] = [];
    const all = collectInstanceRuns(4, (i) => { visited.push(i); return true; });
    assert.deepEqual(all, [{ first: 0, count: 4 }], 'the common case stays one draw');
    assert.deepEqual(visited, [0, 1, 2, 3]);
    assert.deepEqual(collectInstanceRuns(3, () => false), []);
    assert.deepEqual(collectInstanceRuns(0, () => true), []);
    assert.deepEqual(collectInstanceRuns(5, (i) => i !== 0 && i !== 2), [{ first: 1, count: 1 }, { first: 3, count: 2 }]);
  });

  it('draws each run through firstInstance and reports the draw-call count', () => {
    const calls: number[][] = [];
    const pass = { drawIndexed: (...args: number[]) => { calls.push(args); } } as unknown as GPURenderPassEncoder;
    assert.equal(drawInstanceRuns(pass, 36, [{ first: 0, count: 2 }, { first: 3, count: 4 }]), 2);
    assert.deepEqual(calls, [[36, 2, 0, 0, 0], [36, 4, 0, 0, 3]]);
    assert.equal(drawInstanceRuns(pass, 36, []), 0);
  });
});
