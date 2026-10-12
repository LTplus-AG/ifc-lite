/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The selection highlight redraws a piece with `greater-equal` and no depth
 * bias, so its copy must be BIT-coincident with the surface it covers. A
 * textured piece (#7503) never enters a colour bucket: it draws its raw positions
 * against its own origin. Building its highlight in the model's batch frame
 * (`fr(p + (origin - sharedOrigin))`) shifted every vertex by f32 rounding and
 * the highlight z-fought the texture in patches.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Scene } from './scene.js';
import { uploadIndividualMesh } from './individual-mesh-upload.js';
import { interleaveTexturedVertices } from './textured-vertices.js';
import type { MeshData } from '@ifc-lite/geometry';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};
(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
};

function fakeDevice(): { device: GPUDevice; writes: ArrayBuffer[] } {
  const writes: ArrayBuffer[] = [];
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (desc: GPUBufferDescriptor) => ({ destroy() {}, size: desc.size, getMappedRange: () => new ArrayBuffer(desc.size), unmap() {} }),
    createBindGroup: () => ({}),
    createTexture: () => ({ destroy() {}, createView: () => ({}) }),
    createSampler: () => ({}),
    queue: {
      writeBuffer: (_b: unknown, _o: number, data: ArrayBuffer | ArrayBufferView) => {
        writes.push(ArrayBuffer.isView(data) ? (data.buffer as ArrayBuffer).slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
      },
      writeTexture: () => {},
      copyExternalImageToTexture: () => {},
    },
  };
  return { device: device as unknown as GPUDevice, writes };
}

const fakePipeline = {
  createTexturedBindGroup: () => ({}),
  createBindGroup: () => ({}),
  getUniformBufferSize: () => 256,
  getBindGroupLayout: () => ({}),
} as unknown as Parameters<Scene['appendToBatches']>[2];

// Positions with no short binary expansion: folding a non-zero frame delta
// into them in f32 rounds, which is exactly the drift that z-fought.
const POSITIONS = [0.1, 0.2, 0.3, 1.7, 0.1, 0.3, 0.1, 2.9, 0.3];

function mesh(expressId: number, origin: [number, number, number], textured: boolean): MeshData {
  const base: MeshData = {
    expressId,
    positions: new Float32Array(POSITIONS),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    origin,
  };
  if (textured) {
    base.uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
    base.texture = { width: 1, height: 1, rgba: new Uint8Array([255, 255, 255, 255]), repeatS: false, repeatT: false };
  }
  return base;
}

/** xyz of each vertex, from a stride (in floats) interleaved buffer. */
function positionsOf(buffer: ArrayBuffer, strideFloats: number): number[] {
  const f = new Float32Array(buffer);
  const out: number[] = [];
  for (let i = 0; i < f.length; i += strideFloats) out.push(f[i], f[i + 1], f[i + 2]);
  return out;
}

function highlightVertices(piece: MeshData, frame: Parameters<typeof uploadIndividualMesh>[2]) {
  const { device, writes } = fakeDevice();
  const gpu = uploadIndividualMesh(device, piece, frame);
  return { positions: positionsOf(writes[0], 7), rteOrigin: gpu.rteOrigin, translation: [gpu.transform.m[12], gpu.transform.m[13], gpu.transform.m[14]] };
}

function seed(): { scene: Scene; piece: MeshData } {
  const scene = new Scene();
  const { device } = fakeDevice();
  // A colour mesh far from the textured one establishes the model's shared
  // batch frame, so the textured piece's origin differs from it.
  scene.appendToBatches([mesh(1, [100.37, 3.11, -41.9], false), mesh(2, [12.5, 10.5, -3.25], true)], device, fakePipeline);
  const piece = scene.getMeshDataPieces(2)![0];
  return { scene, piece };
}

describe('textured selection highlight is built in the textured draw frame', () => {
  it('reports the textured drawable origin, and none for a colour-batch piece', () => {
    const { scene, piece } = seed();
    assert.deepStrictEqual(scene.getTexturedDrawOrigin(piece), scene.getTexturedMeshes()[0].origin);
    assert.strictEqual(scene.getTexturedDrawOrigin(scene.getMeshDataPieces(1)![0]), null);
  });

  it('writes vertices bit-identical to the textured buffer and draws at its origin', () => {
    const { scene, piece } = seed();
    const tm = scene.getTexturedMeshes()[0];
    const textured = positionsOf(interleaveTexturedVertices(piece)!, 9);
    const hl = highlightVertices(piece, { sharedOrigin: scene.getTexturedDrawOrigin(piece), quantized: false });
    assert.deepStrictEqual(hl.positions, textured);
    assert.deepStrictEqual(hl.rteOrigin, [...tm.origin]);
    assert.deepStrictEqual(hl.translation, [...tm.origin]);
  });

  it('the batch frame it replaces is NOT coincident (the z-fight)', () => {
    const { scene, piece } = seed();
    const shared = scene.getSharedFrameOrigin(piece.modelIndex, piece);
    assert.ok(shared, 'the colour mesh established a shared frame');
    const textured = positionsOf(interleaveTexturedVertices(piece)!, 9);
    const hl = highlightVertices(piece, { sharedOrigin: shared, quantized: false });
    assert.notDeepStrictEqual(hl.positions, textured);
  });

  it('follows the textured drawable through a model translation', () => {
    const { scene } = seed();
    scene.setModelTranslation(0, [5.3, -0.7, 2.1]);
    const piece = scene.getMeshDataPieces(2)![0];
    const tm = scene.getTexturedMeshes()[0];
    const origin = scene.getTexturedDrawOrigin(piece);
    assert.deepStrictEqual(origin, tm.origin);
    const hl = highlightVertices(piece, { sharedOrigin: origin, quantized: false });
    assert.deepStrictEqual(hl.positions, positionsOf(interleaveTexturedVertices(piece)!, 9));
  });
});
