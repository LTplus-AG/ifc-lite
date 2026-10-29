/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Scene.appendToBatches` scans a mesh's triangles for f32 topology once per
 * frame, not once for input validation and again for bucket routing (#8201).
 *
 * The scan calls `Math.fround` nine times per non-degenerate triangle and the
 * rest of the append path does not rebase vertices through it, so counting
 * those calls measures scan work through the real `appendToBatches`. One scan
 * of the mesh is calibrated by calling the scan directly. An append of one mesh
 * validates it, routes it into a new bucket, and then uploads the bucket (which
 * picks its frame over all of the bucket's meshes, a separate scan this change
 * leaves alone). Validation and routing share one scan, so the total is at
 * most two scans; before the change it was three.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import { originPreservesTriangleTopology } from './scene-precision.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

const device = {
  limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
  createBuffer: (desc: GPUBufferDescriptor) => ({ size: desc.size, destroy() {} }),
  createBindGroup: () => ({}),
  queue: { writeBuffer: () => {} },
} as unknown as GPUDevice;
const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as Parameters<Scene['appendToBatches']>[2];

const TRIANGLES = 2000;

/** A strip of non-degenerate unit triangles. */
function stripMesh(): MeshData {
  const positions = new Float32Array((TRIANGLES + 2) * 3);
  for (let i = 0; i < TRIANGLES + 2; i++) positions.set([i, i % 2, 0], i * 3);
  const indices = new Uint32Array(TRIANGLES * 3);
  for (let t = 0; t < TRIANGLES; t++) indices.set([t, t + 1, t + 2], t * 3);
  return { expressId: 1, color: [0.5, 0.5, 0.5, 1], positions, normals: new Float32Array(positions.length), indices };
}

function countFround<T>(run: () => T): { result: T; calls: number } {
  const original = Math.fround;
  let calls = 0;
  Math.fround = (x: number) => { calls++; return original(x); };
  try {
    return { result: run(), calls };
  } finally {
    Math.fround = original;
  }
}

describe('appendToBatches topology scan count (#8201)', () => {
  it('scans a mesh once for validation and routing together, and still batches it', () => {
    const oneScan = countFround(() => originPreservesTriangleTopology([stripMesh()], [0, 0, 0])).calls;
    assert.strictEqual(oneScan, TRIANGLES * 9, 'calibration: nine fround calls per triangle');

    const scene = new Scene();
    const { calls } = countFround(() => scene.appendToBatches([stripMesh()], device, pipeline));
    assert.ok(calls >= oneScan, 'the append still validates the mesh');
    assert.ok(calls <= oneScan * 2, `append made ${calls} fround calls; at most two scans (${oneScan * 2}) are expected, three would be ${oneScan * 3}`);
    assert.strictEqual(scene.getBatchedMeshes().length, 1);
  });
});
