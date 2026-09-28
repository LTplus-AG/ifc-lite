/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { HoverMeshCache } from './hover-mesh-cache.js';

(globalThis as Record<string, unknown>).GPUBufferUsage ??= { VERTEX: 32, INDEX: 16, COPY_DST: 8, UNIFORM: 64 };

/**
 * The hover pre-highlight's GPU copies (#5390): uploaded once per hovered
 * entity, every piece, and destroyed when the hover moves on.
 */
function fakeDevice() {
  const buffers: { destroyed: boolean }[] = [];
  const device = {
    createBuffer: () => { const b = { destroyed: false, destroy() { b.destroyed = true; } }; buffers.push(b); return b; },
    queue: { writeBuffer() {} },
  } as unknown as GPUDevice;
  return { device, buffers };
}

const piece = (expressId: number): MeshData => ({
  expressId,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
  color: [1, 1, 1, 1],
});
const frame = () => ({ sharedOrigin: null, quantized: false });

describe('HoverMeshCache (#5390)', () => {
  it('uploads every piece of the hovered entity once while the hover is unchanged', () => {
    const { device, buffers } = fakeDevice();
    const cache = new HoverMeshCache();
    let reads = 0;
    const pieces = () => { reads++; return [piece(7), piece(7)]; };
    const first = cache.resolve(device, 7, 0, pieces, frame);
    const again = cache.resolve(device, 7, 0, pieces, frame);
    assert.equal(first.length, 2);
    assert.strictEqual(again, first);
    assert.equal(reads, 1, 'pieces are read and uploaded once per hovered entity');
    assert.equal(buffers.length, 4, 'a vertex and an index buffer per piece');
  });

  it('destroys the previous copies when the hover moves, and on release', () => {
    const { device, buffers } = fakeDevice();
    const cache = new HoverMeshCache();
    cache.resolve(device, 7, 0, () => [piece(7)], frame);
    cache.resolve(device, 8, 0, () => [piece(8)], frame);
    assert.deepEqual(buffers.map((b) => b.destroyed), [true, true, false, false]);
    cache.release();
    assert.ok(buffers.every((b) => b.destroyed));
  });

  it('keys by model too, so the same id in another federated model re-uploads', () => {
    const { device } = fakeDevice();
    const cache = new HoverMeshCache();
    const a = cache.resolve(device, 7, 0, () => [piece(7)], frame);
    const b = cache.resolve(device, 7, 1, () => [piece(7)], frame);
    assert.notStrictEqual(a, b);
  });
});
