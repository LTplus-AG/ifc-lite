/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #1973 — textured meshes must reconstruct `world = origin + position`.
 *
 * `transform_mesh_world_framed` (on by default for wasm) stores each element's
 * vertices RELATIVE to a per-element `MeshData.origin` so the world magnitude
 * stays out of f32. The batch path folds that origin into the shared frame; the
 * textured sub-pass hard-zeroed its model translation, so every textured
 * occurrence drew offset by `-origin` — collapsed toward the world origin,
 * while CPU picking used the correctly placed geometry.
 *
 * The invariant asserted here is the one the issue asks for: a textured face
 * set and its untextured twin land at the same world AABB. Buffer allocation
 * and draws need a real GPUDevice, but the origin bookkeeping and the
 * interleaved vertex data are GPU-agnostic, so a capturing stub suffices.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Scene } from './scene.js';
import { mergeGeometry } from './scene-geometry.js';
import type { MeshData } from './types.js';

// WebGPU enum globals used by Scene buffer/texture creation (not defined in
// node) — same stub the other renderer tests install.
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};
(globalThis as Record<string, unknown>).GPUTextureUsage = {
  COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
};

/** Captures every `writeBuffer` payload so the interleaved vertices can be read back. */
function fakeDevice(): { device: GPUDevice; writes: ArrayBuffer[] } {
  const writes: ArrayBuffer[] = [];
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: () => ({ destroy() {}, size: 0 }),
    createTexture: () => ({ destroy() {}, createView: () => ({}) }),
    createSampler: () => ({}),
    queue: {
      writeBuffer: (_b: unknown, _o: number, data: ArrayBuffer | ArrayBufferView) => {
        writes.push(ArrayBuffer.isView(data) ? data.buffer as ArrayBuffer : data);
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
} as unknown as Parameters<Scene['appendToBatches']>[2];

/** A unit triangle at the model origin, offset into world space by `origin`. */
function meshData(expressId: number, origin: [number, number, number], textured: boolean): MeshData {
  const base: Record<string, unknown> = {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    origin,
  };
  if (textured) {
    base.uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
    base.texture = { width: 1, height: 1, data: new Uint8Array([255, 255, 255, 255]) };
  }
  return base as unknown as MeshData;
}

/** World-space AABB of `positions` once `origin` is folded back in. */
function worldBounds(positions: ArrayLike<number>, origin: [number, number, number]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const w = positions[i + a] + origin[a];
      if (w < min[a]) min[a] = w;
      if (w > max[a]) max[a] = w;
    }
  }
  return { min, max };
}

/** Positions read out of the stride-36 interleaved textured vertex layout. */
function texturedPositions(interleaved: ArrayBuffer, vertexCount: number): number[] {
  const f = new Float32Array(interleaved);
  const out: number[] = [];
  for (let i = 0; i < vertexCount; i++) out.push(f[i * 9], f[i * 9 + 1], f[i * 9 + 2]);
  return out;
}

// A real occurrence origin: SketchUp/BIM-Tools exports place elements via a
// normal IfcLocalPlacement chain, so the elevation lives in `origin`.
const ORIGIN: [number, number, number] = [12.5, 10.5, -3.25];

describe('textured meshes carry their per-element origin (#1973)', () => {
  it('records MeshData.origin on the TexturedMesh', () => {
    const scene = new Scene();
    const { device } = fakeDevice();

    scene.appendToBatches([meshData(1, ORIGIN, true)], device, fakePipeline);

    const textured = scene.getTexturedMeshes();
    assert.strictEqual(textured.length, 1);
    assert.deepStrictEqual([...textured[0].origin], ORIGIN);
  });

  it('lands at the same world AABB as an untextured twin', () => {
    const scene = new Scene();
    const { device, writes } = fakeDevice();

    scene.appendToBatches([meshData(1, ORIGIN, true)], device, fakePipeline);

    const textured = scene.getTexturedMeshes()[0];
    // The vertex buffer is the first (and largest) write; positions must still
    // be LOCAL — folding the world magnitude into f32 here would defeat the
    // local frame the origin exists to provide.
    const interleaved = writes.find((w) => w.byteLength === 3 * 36);
    assert.ok(interleaved, 'interleaved vertex buffer was uploaded');
    const positions = texturedPositions(interleaved, 3);
    assert.deepStrictEqual(positions, [0, 0, 0, 1, 0, 0, 0, 1, 0]);

    // The batch path is the reference: it reconstructs world = origin + position.
    const merged = mergeGeometry([meshData(2, ORIGIN, false)]);

    const texturedWorld = worldBounds(positions, [...textured.origin] as [number, number, number]);
    assert.deepStrictEqual(texturedWorld.min, [...merged.bounds.min]);
    assert.deepStrictEqual(texturedWorld.max, [...merged.bounds.max]);
    // And it is genuinely offset from the model origin — a regression that
    // dropped `origin` would put this AABB at [0,0,0]..[1,1,0] and still agree
    // with itself.
    assert.deepStrictEqual(texturedWorld.min, [12.5, 10.5, -3.25]);
  });

  it('keeps origin at zero for absolute-position meshes', () => {
    // The #961 orphan type-geometry path runs `transform_mesh_local`, which
    // leaves positions absolute and `origin` unset.
    const scene = new Scene();
    const { device } = fakeDevice();
    const md = meshData(1, [0, 0, 0], true);
    delete (md as unknown as Record<string, unknown>).origin;

    scene.appendToBatches([md], device, fakePipeline);

    assert.deepStrictEqual([...scene.getTexturedMeshes()[0].origin], [0, 0, 0]);
  });
});
