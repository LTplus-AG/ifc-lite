/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import { RgbaTexturePool } from './rgba-texture-pool.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = { COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64 };
(globalThis as Record<string, unknown>).GPUTextureUsage = { COPY_DST: 2, TEXTURE_BINDING: 4 };

function gpu() {
  const textures: { destroyed: number; destroy(): void; createView(): object }[] = [];
  let writes = 0;
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: () => ({ destroy() {}, size: 0 }),
    createSampler: () => ({}),
    createTexture: () => {
      const texture = { destroyed: 0, destroy() { this.destroyed++; }, createView: () => ({}) };
      textures.push(texture);
      return texture;
    },
    queue: { writeBuffer() {}, writeTexture() { writes++; } },
  };
  return { device: device as unknown as GPUDevice, textures, get writes() { return writes; } };
}

function mesh(expressId: number, rgba: Uint8Array): MeshData {
  return {
    expressId, color: [1, 1, 1, 1],
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]), uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    texture: { rgba, width: 1, height: 1, repeatS: expressId === 1, repeatT: false },
  };
}

const pipeline = {
  getUniformBufferSize: () => 256,
  createTexturedBindGroup: () => ({}),
} as unknown as Parameters<Scene['appendToBatches']>[2];

describe('shared-room pixel GPU ownership (#4228, #4232)', () => {
  it('uploads shared pixels once across surfaces, retaining them until the last object disappears', () => {
    const scene = new Scene(), state = gpu(), pixels = new Uint8Array([255, 0, 0, 255]);
    scene.appendToBatches([mesh(1, pixels), mesh(2, pixels)], state.device, pipeline);
    assert.equal(state.textures.length, 1);
    assert.equal(state.writes, 1);
    assert.equal(scene.getTexturedMeshes().length, 2);
    scene.removeMeshesForEntity(1);
    assert.equal(state.textures[0].destroyed, 0);
    scene.removeMeshesForEntity(2);
    assert.equal(state.textures[0].destroyed, 1);
    scene.clearFlatGeometry();
    assert.equal(state.textures[0].destroyed, 1);
  });

  it('keeps unrelated image arrays separate and destroys every surviving allocation on clear', () => {
    const scene = new Scene(), state = gpu();
    scene.appendToBatches([mesh(1, new Uint8Array(4)), mesh(2, new Uint8Array(4))], state.device, pipeline);
    assert.equal(state.textures.length, 2);
    scene.clearFlatGeometry();
    assert.deepEqual(state.textures.map(texture => texture.destroyed), [1, 1]);
  });

  it('does not alias different image shapes over the same pixels', () => {
    const pool = new RgbaTexturePool(), state = gpu(), rgba = new Uint8Array(8);
    const a = pool.acquire({ rgba, width: 2, height: 1, repeatS: false, repeatT: false }, state.device);
    const b = pool.acquire({ rgba, width: 1, height: 2, repeatS: false, repeatT: false }, state.device);
    assert.notEqual(a, b);
    pool.clear();
    assert.deepEqual(state.textures.map(texture => texture.destroyed), [1, 1]);
  });
});
