/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readDeviationAssetStats } from './deviation/deviation-readback.js';
import type { PointCloudNode } from './pointcloud/point-cloud-node.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = { COPY_DST: 8, MAP_READ: 1 };
(globalThis as Record<string, unknown>).GPUMapMode = { READ: 1 };

interface TestBuffer {
  data: Float32Array;
  unmapped: number;
  destroyed: number;
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}

function buffer(values: number[], mapFails = false): TestBuffer {
  return {
    data: new Float32Array(values), unmapped: 0, destroyed: 0,
    async mapAsync() { if (mapFails) throw new Error('device lost'); },
    getMappedRange() { return this.data.buffer as ArrayBuffer; },
    unmap() { this.unmapped++; },
    destroy() { this.destroyed++; },
  };
}

function node(expressId: number, modelIndex: number, sources: TestBuffer[]): PointCloudNode {
  return {
    meta: { expressId, modelIndex },
    chunks: sources.map((source) => ({ deviationBuffer: source as unknown as GPUBuffer, pointCount: source.data.length })),
  } as unknown as PointCloudNode;
}

function gpu(mapFails = false, unmapFails = false) {
  const staging: TestBuffer[] = [];
  const device = {
    createBuffer: ({ size }: { size: number }) => {
      const target = buffer(new Array(size / 4).fill(0), mapFails);
      if (unmapFails) target.unmap = () => { throw new Error('unmap failed'); };
      staging.push(target);
      return target;
    },
    createCommandEncoder: () => ({
      copyBufferToBuffer: (source: TestBuffer, _sourceOffset: number, target: TestBuffer) => {
        target.data.set(source.data);
      },
      finish: () => ({}),
    }),
    queue: { submit: () => {} },
  };
  return { device: device as unknown as GPUDevice, staging };
}

describe('on-demand signed-distance readback (#5832)', () => {
  it('aggregates each scan asset separately across chunks, and skips buffers never computed', async () => {
    const a1 = buffer([-0.25, 0.5]);
    const a2 = buffer([0.25, Number.NaN]);
    const uncomputed = buffer([99]);
    const b = buffer([-1, 1]);
    const { device, staging } = gpu();
    const rows = await readDeviationAssetStats(device, [
      node(7, 1, [a1, a2, uncomputed]),
      node(8, 2, [b]),
    ], (candidate) => candidate !== (uncomputed as unknown as GPUBuffer));

    assert.deepEqual(rows, [
      { expressId: 7, modelIndex: 1, pointsProcessed: 4, finitePoints: 3,
        minimumDeviation: -0.25, maximumDeviation: 0.5, meanDeviation: 1 / 6 },
      { expressId: 8, modelIndex: 2, pointsProcessed: 2, finitePoints: 2,
        minimumDeviation: -1, maximumDeviation: 1, meanDeviation: 0 },
    ]);
    assert.equal(staging.length, 3);
    assert.ok(staging.every((item) => item.unmapped === 1 && item.destroyed === 1));
  });

  it('destroys the staging buffer when GPU mapping rejects', async () => {
    const source = buffer([1]);
    const { device, staging } = gpu(true);
    await assert.rejects(readDeviationAssetStats(device, [node(7, 0, [source])], () => true), /device lost/);
    assert.equal(staging[0].unmapped, 0);
    assert.equal(staging[0].destroyed, 1);
  });

  it('destroys the staging buffer when unmap fails after reading', async () => {
    const source = buffer([1]);
    const { device, staging } = gpu(false, true);
    await assert.rejects(readDeviationAssetStats(device, [node(7, 0, [source])], () => true), /unmap failed/);
    assert.equal(staging[0].destroyed, 1);
  });
});
