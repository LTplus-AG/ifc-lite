/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectInstanceRuns,
  createInstancedRteDeltaStream,
  drawInstanceRuns,
  invalidateInstancedRteDeltas,
  INSTANCED_RTE_DELTA_STRIDE_BYTES,
  uploadInstancedRteDeltas,
  type InstancedRteTemplate,
} from './instanced-rte.js';
import { rteRelativePositionF32, type WorldPoint } from './relative-to-eye.js';

// WebGPU enum global used by delta-stream allocation (not defined in node).
(globalThis as Record<string, unknown>).GPUBufferUsage ??= { COPY_DST: 8, VERTEX: 32 };

interface Write { buffer: GPUBuffer; offset: number; data: Float32Array }

function recordingDevice() {
  const writes: Write[] = [];
  const device = {
    createBuffer: ({ size }: GPUBufferDescriptor) => ({ size, destroy() {} }),
    queue: {
      writeBuffer: (buffer: GPUBuffer, offset: number, data: ArrayBufferView) => {
        writes.push({ buffer, offset, data: new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) });
      },
    },
  } as unknown as GPUDevice;
  return { device, writes };
}

function template(device: GPUDevice, anchors: number[]): InstancedRteTemplate {
  const instanceCount = anchors.length / 3;
  return { instanceCount, canonicalAnchors: new Float64Array(anchors), rteDeltas: createInstancedRteDeltaStream(device, instanceCount) };
}

/** The f64 world point an instance's uploaded high/low lanes reconstruct, relative to `camera`. */
function uploadedWorld(write: Write, firstInstance: number, instance: number, camera: WorldPoint): number[] {
  const lanes = write.data.subarray((instance - firstInstance) * 8, (instance - firstInstance + 1) * 8);
  const relative = rteRelativePositionF32([0, 0, 0], lanes);
  return [relative[0] + camera[0], relative[1] + camera[1], relative[2] + camera[2]];
}

describe('instanced RTE submission deltas (#5049)', () => {
  it('preserves Astra’s 15.625 mm national-grid witness through the delta stream', () => {
    const { device, writes } = recordingDevice();
    uploadInstancedRteDeltas(device, [template(device, [5_000_000.015625, -2, 4])], [5_000_000, -2, 4]);

    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.offset, 0);
    const relative = rteRelativePositionF32([0, 0, 0], writes[0]!.data);
    assert.ok(Math.abs(relative[0] - 0.015625) < 1e-8, `lost source residual: ${relative[0]}`);
  });

  it('enforces the same source envelope for every pass', () => {
    const { device } = recordingDevice();
    const rejecting = { ...device, queue: { writeBuffer() { throw new Error('must not upload rejected data'); } } } as unknown as GPUDevice;
    assert.throws(() => uploadInstancedRteDeltas(rejecting, [template(device, [1_000_000_001, 0, 0])], [1_000_000_001, 0, 0]), /source envelope/);
    assert.throws(() => uploadInstancedRteDeltas(rejecting, [template(device, [0, 0, 0])], [1_000_000_001, 0, 0]), /source envelope/);
  });

  it('rejects anchors that do not match the record count', () => {
    const { device } = recordingDevice();
    const t = template(device, [0, 0, 0, 1, 1, 1]);
    assert.throws(() => uploadInstancedRteDeltas(device, [{ ...t, instanceCount: 3 }], [0, 0, 0]), RangeError);
  });

  it('skips out-of-envelope instances and returns the drawable runs (#6128)', () => {
    const { device, writes } = recordingDevice();
    const far = 2_000_000;
    const templates = [
      // near, near, FAR, near, FAR, FAR
      template(device, [0, 0, 0, 1, 0, 0, far, 0, 0, 2, 0, 0, far, 0, 0, far, 0, 0]),
      template(device, [far, 0, 0]),
      template(device, [0, 0, 0, 0, 0, 1]),
    ];
    const runs = uploadInstancedRteDeltas(device, templates, [0, 0, 0]);

    assert.deepEqual(runs, [
      [{ first: 0, count: 2 }, { first: 3, count: 1 }],
      [],
      [{ first: 0, count: 2 }],
    ]);
    // A template with no drawable instance uploads nothing; the others upload
    // only the span their runs cover, never the trailing FAR instances.
    assert.deepEqual(writes.map((w) => [templates.findIndex((t) => t.rteDeltas.buffer === w.buffer), w.offset, w.data.length]), [
      [0, 0, 4 * 8],
      [2, 0, 2 * 8],
    ]);
  });
});

describe('instanced RTE delta stream — one upload per template per camera (#6393)', () => {
  it('uploads each template in ONE writeBuffer whose span holds every instance\'s delta', () => {
    const { device, writes } = recordingDevice();
    const camera: WorldPoint = [5_000_000, 10, -3];
    const anchors = [];
    for (let i = 0; i < 50; i++) anchors.push(5_000_000 + i * 0.015625, 10 + i, -3 - i);
    const big = template(device, anchors);
    const small = template(device, [5_000_001, 11, -4]);

    const runs = uploadInstancedRteDeltas(device, [big, small], camera);

    assert.deepEqual(runs, [[{ first: 0, count: 50 }], [{ first: 0, count: 1 }]]);
    assert.equal(writes.length, 2, 'one write per template, not one per instance');
    const [bigWrite, smallWrite] = writes as [Write, Write];
    assert.equal(bigWrite.buffer, big.rteDeltas.buffer);
    assert.equal(bigWrite.offset, 0);
    assert.equal(bigWrite.data.byteLength, 50 * INSTANCED_RTE_DELTA_STRIDE_BYTES);
    for (let i = 0; i < 50; i++) {
      assert.deepEqual(uploadedWorld(bigWrite, 0, i, camera), [5_000_000 + i * 0.015625, 10 + i, -3 - i], `instance ${i}`);
    }
    assert.equal(smallWrite.buffer, small.rteDeltas.buffer);
    assert.deepEqual(uploadedWorld(smallWrite, 0, 0, camera), [5_000_001, 11, -4]);
  });

  it('starts the span at the first drawable instance, so leading far instances are neither drawn nor uploaded', () => {
    const { device, writes } = recordingDevice();
    const far = 2_000_000;
    const t = template(device, [far, 0, 0, far, 0, 0, 1, 0, 0, far, 0, 0, 2, 0, 0, far, 0, 0]);

    const [runs] = uploadInstancedRteDeltas(device, [t], [0, 0, 0]);

    assert.deepEqual(runs, [{ first: 2, count: 1 }, { first: 4, count: 1 }]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.offset, 2 * INSTANCED_RTE_DELTA_STRIDE_BYTES);
    assert.equal(writes[0]!.data.byteLength, 3 * INSTANCED_RTE_DELTA_STRIDE_BYTES, 'instances 2..4 inclusive');
    assert.deepEqual(uploadedWorld(writes[0]!, 2, 2, [0, 0, 0]), [1, 0, 0]);
    assert.deepEqual(uploadedWorld(writes[0]!, 2, 4, [0, 0, 0]), [2, 0, 0]);
  });

  it('is a cache hit for the same camera: shadow, colour and mask in one frame upload once', () => {
    const { device, writes } = recordingDevice();
    const far = 2_000_000;
    const t = template(device, [0, 0, 0, far, 0, 0, 1, 1, 1]);
    const camera: WorldPoint = [0.5, 0, 0];

    const first = uploadInstancedRteDeltas(device, [t], camera);
    const second = uploadInstancedRteDeltas(device, [t], [camera[0], camera[1], camera[2]]);
    const third = uploadInstancedRteDeltas(device, [t], camera);

    assert.equal(writes.length, 1, 'equal camera components never re-upload');
    assert.deepEqual(second, first, 'the cached runs still exclude the out-of-envelope instance');
    assert.deepEqual(third, first);

    uploadInstancedRteDeltas(device, [t], [0.5, 0, 1e-9]);
    assert.equal(writes.length, 2, 'any camera change re-uploads');
  });

  it('re-uploads after invalidation even at an unchanged camera', () => {
    const { device, writes } = recordingDevice();
    const t = template(device, [1, 2, 3]);
    uploadInstancedRteDeltas(device, [t], [0, 0, 0]);

    t.canonicalAnchors[0] = 7;
    invalidateInstancedRteDeltas(t.rteDeltas);
    uploadInstancedRteDeltas(device, [t], [0, 0, 0]);

    assert.equal(writes.length, 2);
    assert.deepEqual(uploadedWorld(writes[1]!, 0, 0, [0, 0, 0]), [7, 2, 3]);
  });

  it('recomputes runs when the camera moves an instance out of the envelope', () => {
    const { device } = recordingDevice();
    const t = template(device, [0, 0, 0, 900_000, 0, 0]);
    assert.deepEqual(uploadInstancedRteDeltas(device, [t], [0, 0, 0]), [[{ first: 0, count: 2 }]]);
    assert.deepEqual(uploadInstancedRteDeltas(device, [t], [-900_000, 0, 0]), [[{ first: 0, count: 1 }]]);
  });

  it('keeps the previous stream state when an upload is rejected', () => {
    const { device, writes } = recordingDevice();
    const t = template(device, [0, 0, 0]);
    uploadInstancedRteDeltas(device, [t], [0, 0, 0]);
    assert.throws(() => uploadInstancedRteDeltas(device, [t], [1_000_000_001, 0, 0]), /source envelope/);
    uploadInstancedRteDeltas(device, [t], [0, 0, 0]);
    assert.equal(writes.length, 1, 'the rejected camera never replaced the cached one');
  });
});

describe('instance runs', () => {
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
