/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5582 — a batch draws with ONE material row (`packMeshMaterial`, patched
 * once per batch in `renderBatch`), so two pieces that share a colour but
 * author DIFFERENT IFC specular finishes (`MeshData.material`) must never
 * land in the same batch: `Scene`'s bucket key (`chunk-grid.ts`'s `colorKey`)
 * now folds `metallic`/`roughness` in alongside RGBA.
 *
 * Uses only `Scene`'s public surface (`appendToBatches`, `getBatchedMeshes`),
 * the same fake-GPU-device idiom `scene-textured-origin.test.ts` uses — no
 * real WebGPU needed for bucketing/batch-count assertions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Scene } from './scene.js';
import type { MeshData } from '@ifc-lite/geometry';
import { createSceneBatchShell } from './scene-batch-upload.js';
import type { BatchedMesh } from './types.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

function fakeDevice(): { device: GPUDevice } {
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (desc: GPUBufferDescriptor) => ({
      destroy() {}, size: desc.size, getMappedRange: () => new ArrayBuffer(desc.size), unmap() {},
    }),
    createBindGroup: () => ({}),
    queue: { writeBuffer: () => {} },
  };
  return { device: device as unknown as GPUDevice };
}

const fakePipeline = {
  createBindGroup: () => ({}),
  getUniformBufferSize: () => 256,
  getBindGroupLayout: () => ({}),
} as unknown as Parameters<Scene['appendToBatches']>[2];

/** A unit triangle at a distinct world position (`x` keeps AABBs apart). */
function meshData(expressId: number, x: number, material?: MeshData['material']): MeshData {
  return {
    expressId,
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [0.8, 0.8, 0.8, 1],
    ...(material ? { material } : {}),
  };
}

describe('batching folds IFC-authored material into the colour key (#5582)', () => {
  it('never merges the same colour with different metallic into one batch', () => {
    const { device } = fakeDevice();
    const scene = new Scene();
    const dielectric = meshData(1, 0, { metallic: 0, roughness: 0.9 });
    const metal = meshData(2, 10, { metallic: 1, roughness: 0.2 });
    scene.appendToBatches([dielectric, metal], device, fakePipeline);

    const batches = scene.getBatchedMeshes();
    assert.equal(batches.length, 2, 'same colour, different metallic -> must not share a batch');
    const materials = batches.map((b) => b.finish?.metallic).sort();
    assert.deepEqual(materials, [0, 1]);
  });

  it('never merges the same colour with different roughness into one batch', () => {
    const { device } = fakeDevice();
    const scene = new Scene();
    const glossy = meshData(3, 0, { metallic: 0, roughness: 0.05 });
    const matte = meshData(4, 10, { metallic: 0, roughness: 0.9 });
    scene.appendToBatches([glossy, matte], device, fakePipeline);

    const batches = scene.getBatchedMeshes();
    assert.equal(batches.length, 2, 'same colour, different roughness -> must not share a batch');
  });

  it('still merges the same colour when neither piece authors a material (no batch-count regression)', () => {
    const { device } = fakeDevice();
    const scene = new Scene();
    scene.appendToBatches([meshData(5, 0), meshData(6, 10)], device, fakePipeline);

    assert.equal(scene.getBatchedMeshes().length, 1, 'unauthored pieces of the same colour still co-batch');
  });

  it('still merges the same colour AND the same authored material into one batch', () => {
    const { device } = fakeDevice();
    const scene = new Scene();
    const a = meshData(7, 0, { metallic: 1, roughness: 0.2 });
    const b = meshData(8, 10, { metallic: 1, roughness: 0.2 });
    scene.appendToBatches([a, b], device, fakePipeline);

    const batches = scene.getBatchedMeshes();
    assert.equal(batches.length, 1, 'identical colour and material -> one batch');
    assert.equal(batches[0].expressIds.length, 2);
  });

  it('keeps the finish on colour-override batches, split per source material', () => {
    const { device } = fakeDevice();
    const scene = new Scene();
    scene.appendToBatches([meshData(9, 0, { metallic: 0, roughness: 0.9 }), meshData(10, 10, { metallic: 1, roughness: 0.2 })], device, fakePipeline);
    scene.setColorOverrides(new Map([[9, [1, 0, 0, 1]], [10, [1, 0, 0, 1]]]), device, fakePipeline);

    const overlays = scene.getOverrideBatches();
    assert.equal(overlays.length, 2, 'one override colour over two finishes -> two overlay batches');
    assert.deepEqual(overlays.map((b) => b.finish?.metallic).sort(), [0, 1]);
    assert.deepEqual(overlays.map((b) => b.colorKey).sort(), ['1000|0|0|1000|0|900', '1000|0|0|1000|1000|200'],
      'the overlay label carries its finish, like the bucket key it came from');
  });

  it('a shell batch (shared source buffers) carries the finish on `finish`, the field the draw path reads', () => {
    const source = { vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, origin: undefined } as unknown as BatchedMesh;
    const shell = createSceneBatchShell([meshData(11, 0, { metallic: 1, roughness: 0.2 })], source, 1, 'k');
    assert.deepEqual(shell.finish, { metallic: 1, roughness: 0.2 });
    assert.equal('material' in shell, false, 'nothing reads a batch-level material');
  });
});

