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
import { modelPlacementBounds, sceneMeshBounds } from './model-placement-bounds.js';
import { Scene } from './scene.js';
import { mergeGeometry } from './scene-geometry.js';
import type { MeshData } from '@ifc-lite/geometry';

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
    createBuffer: (desc: GPUBufferDescriptor) => ({ destroy() {}, size: desc.size, getMappedRange: () => new ArrayBuffer(desc.size), unmap() {} }),
    createBindGroup: () => ({}),
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
  getBindGroupLayout: () => ({}),
} as unknown as Parameters<Scene['appendToBatches']>[2];

/** A unit triangle at the model origin, offset into world space by `origin`. */
function meshData(expressId: number, origin: [number, number, number], textured: boolean): MeshData {
  const base: MeshData = {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
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


it('moves only the owning textured model and keeps texture uploads stable (#4226)', () => {
  const scene = new Scene(), { device, writes } = fakeDevice();
  const moving = { ...meshData(1, ORIGIN, true), modelIndex: 7 };
  const fixed = { ...meshData(2, [0, 0, 0], true), modelIndex: 0 };
  scene.appendToBatches([moving, fixed], device, fakePipeline);
  const uploads = writes.length;
  scene.setModelTranslation(7, [100, 200, 300]);
  const meshes = scene.getTexturedMeshes();
  assert.deepStrictEqual(meshes.find((m) => m.expressId === 1)!.origin, [112.5, 210.5, 296.75]);
  assert.deepStrictEqual(meshes.find((m) => m.expressId === 2)!.origin, [0, 0, 0]);
  assert.strictEqual(writes.length, uploads, 'moving a textured model does not re-upload its vertices or texture');
  assert.deepStrictEqual(moving.origin, ORIGIN, 'the source placement remains unchanged');
  scene.setModelTranslation(7, [0, 0, 0]);
  assert.deepStrictEqual(meshes.find((m) => m.expressId === 1)!.origin, ORIGIN);
  scene.clear();
});

it('frames textured pieces by model even when entity ids coincide (#4226)', () => {
  const scene = new Scene(), { device } = fakeDevice();
  scene.appendToBatches([{ ...meshData(1, ORIGIN, true), modelIndex: 7 },
    { ...meshData(1, [0, 0, 0], true), modelIndex: 0 }], device, fakePipeline);
  scene.releaseGeometryData(); scene.setModelTranslation(7, [100, 0, 0]);
  assert.deepStrictEqual(modelPlacementBounds(scene, null, 0), { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } });
  assert.strictEqual(modelPlacementBounds(scene, null, 7)!.min.x, 112.5);
  assert.deepStrictEqual(sceneMeshBounds(scene), { min: { x: 0, y: 0, z: -3.25 }, max: { x: 113.5, y: 11.5, z: 0 } });
  scene.clear();
});

for (const edit of ['translate', 'rotate'] as const) it(`refreshes textured bounds after ${edit} and subsequent model placement (#4226)`, () => {
  const scene = new Scene(), { device, writes } = fakeDevice();
  scene.appendToBatches([{ ...meshData(1, [0, 0, 0], true), modelIndex: 7 }], device, fakePipeline);
  scene.setModelTranslation(7, [100, 0, 0]);
  if (edit === 'translate') scene.translateMeshesForEntity(1, [2, 3, 4]);
  else scene.rotateMeshesForEntity(1, Math.PI / 2, [100, 0, 0]);
  const drawable = scene.getTexturedMeshes()[0];
  const expected = worldBounds(texturedPositions(writes.at(-1)!, 3), [...drawable.origin]);
  assert.deepStrictEqual(drawable.bounds, expected, 'bounds enclose the actual uploaded vertices');
  scene.setModelTranslation(7, [110, 0, 0]);
  const moved = { min: [...expected.min], max: [...expected.max] };
  moved.min[0] += 10; moved.max[0] += 10;
  assert.deepStrictEqual(drawable.bounds, moved, 'the next preview retains the geometry edit');
  scene.setModelTranslation(7, [0, 0, 0]);
  assert.strictEqual(drawable.bounds!.min[0], expected.min[0] - 100);
  scene.clear();
});

// #4308: insertion is invisible until commit, and cancellation frees every allocation.
describe('prepared textured owner insertion (#4308)', () => {
  it('keeps prepared geometry outside rendering and picking until commit', () => {
    const scene = new Scene(), { device } = fakeDevice();
    const prepared = scene.prepareTexturedOwner(meshData(55, ORIGIN, true), device, fakePipeline);
    assert.equal(scene.getMeshDataPieces(55), undefined);
    assert.equal(scene.getTexturedMeshes().length, 0);
    prepared.commit(); prepared.commit(); prepared.dispose();
    assert.equal(scene.getMeshDataPieces(55)?.length, 1);
    assert.equal(scene.getTexturedMeshes().length, 1);
    assert.throws(() => scene.prepareTexturedOwner(meshData(55, ORIGIN, true), device, fakePipeline), /already exists/);
    scene.removeMeshesForEntity(55);
    assert.equal(scene.getTexturedMeshes().length, 0);
  });
  it('releases cancelled resources exactly once and rejects a late commit', () => {
    const scene = new Scene(), { device } = fakeDevice();
    const destroyed: number[] = [];
    let texturesDestroyed = 0;
    const createTexture = device.createTexture;
    device.createTexture = descriptor => {
      const texture = createTexture(descriptor);
      texture.destroy = () => { texturesDestroyed++; };
      return texture;
    };
    device.createBuffer = (() => {
      const id = destroyed.push(0) - 1;
      return { destroy() { destroyed[id]++; }, size: 0 };
    }) as unknown as GPUDevice['createBuffer'];
    const prepared = scene.prepareTexturedOwner(meshData(56, ORIGIN, true), device, fakePipeline);
    prepared.dispose(); prepared.dispose();
    assert.deepEqual(destroyed, [1, 1, 1]);
    assert.equal(texturesDestroyed, 1);
    assert.equal(scene.getMeshDataPieces(56), undefined);
    assert.equal(scene.getTexturedMeshes().length, 0);
    assert.throws(() => prepared.commit(), /released/);
  });
  it('unwinds an allocation failure without registering a partial owner', () => {
    const scene = new Scene(), { device } = fakeDevice();
    let released = 0, allocations = 0;
    device.createBuffer = (() => {
      if (++allocations === 2) throw new Error('injected allocation failure');
      return { destroy() { released++; }, size: 0 };
    }) as unknown as GPUDevice['createBuffer'];
    assert.throws(() => scene.prepareTexturedOwner(meshData(57, ORIGIN, true), device, fakePipeline), /injected/);
    assert.equal(released, 1);
    assert.equal(scene.getMeshDataPieces(57), undefined);
    assert.equal(scene.getTexturedMeshes().length, 0);
  });
});

describe('#4406 multi-part authored owner staging', () => {
  it('publishes all colour parts together and keeps concurrent detached owners distinct', () => {
    const scene = new Scene(), { device } = fakeDevice();
    const red = { ...meshData(81, ORIGIN, false), color: [1, 0, 0, 1] as [number, number, number, number] };
    const blue = { ...meshData(81, [ORIGIN[0] + 2, ORIGIN[1], ORIGIN[2]], false), color: [0, 0, 1, 1] as [number, number, number, number] };
    const first = scene.prepareAuthoredOwner([red, blue], device, fakePipeline);
    const second = scene.prepareAuthoredOwner([meshData(82, ORIGIN, false)], device, fakePipeline);
    assert.equal(scene.getMeshDataPieces(81), undefined);
    assert.equal(scene.getBatchedMeshes().length, 0);
    first.commit(); second.commit(); first.dispose(); second.dispose();
    assert.equal(scene.getMeshDataPieces(81)?.length, 2);
    assert.equal(scene.getMeshDataPieces(82)?.length, 1);
    assert.equal(scene.getBatchedMeshes().length, 3);
    assert.deepEqual(scene.getMeshDataPieces(81)?.map(part => part.color), [red.color, blue.color]);
    assert.deepEqual(scene.getMeshDataPieces(81)?.map(part => part.origin), [red.origin, blue.origin]);
    scene.removeMeshesForEntity(81);
    assert.equal(scene.getMeshDataPieces(81), undefined);
    assert.equal(scene.getMeshDataPieces(82)?.length, 1);
    scene.clear();
  });
  it('publishes mixed image and coloured parts without synthetic textures', () => {
    const scene = new Scene(), { device } = fakeDevice();
    const prepared = scene.prepareAuthoredOwner([meshData(83, ORIGIN, true), meshData(83, ORIGIN, false)], device, fakePipeline);
    assert.equal(scene.getTexturedMeshes().length, 0);
    assert.equal(scene.getBatchedMeshes().length, 0);
    prepared.commit();
    assert.equal(scene.getTexturedMeshes().length, 1);
    assert.equal(scene.getBatchedMeshes().length, 1);
    assert.equal(scene.getMeshDataPieces(83)?.length, 2);
    scene.clear();
  });
  it('releases earlier allocations after a later colour fails and leaves no owner', () => {
    const scene = new Scene(), { device } = fakeDevice();
    let allocations = 0, releases = 0;
    device.createBuffer = ((desc: GPUBufferDescriptor) => {
      if (++allocations === 4) throw new Error('second colour allocation failed');
      return { destroy() { releases++; }, size: desc.size, getMappedRange: () => new ArrayBuffer(desc.size), unmap() {} };
    }) as GPUDevice['createBuffer'];
    const first = meshData(84, ORIGIN, false), second = { ...first, color: [0, 0, 1, 1] as [number, number, number, number] };
    assert.throws(() => scene.prepareAuthoredOwner([first, second], device, fakePipeline), /second colour/);
    assert.equal(releases, allocations - 1);
    assert.equal(scene.getMeshDataPieces(84), undefined);
    assert.equal(scene.getBatchedMeshes().length, 0);
  });
  it('refuses stale scenes, foreign owners and malformed geometry before publication', () => {
    const scene = new Scene(), { device } = fakeDevice();
    assert.throws(() => scene.prepareAuthoredOwner([meshData(85, ORIGIN, false), meshData(86, ORIGIN, false)], device, fakePipeline), /identity/);
    assert.throws(() => scene.prepareAuthoredOwner([{ ...meshData(85, ORIGIN, false), indices: new Uint32Array([0, 1, 99]) }], device, fakePipeline), /valid geometry/);
    const prepared = scene.prepareAuthoredOwner([meshData(85, ORIGIN, false)], device, fakePipeline);
    scene.clear();
    assert.throws(() => prepared.commit(), /scene changed/);
    prepared.dispose(); prepared.dispose();
    assert.equal(scene.getMeshDataPieces(85), undefined);
  });
  it('refuses placement changes between detached allocation and publication', () => {
    const scene = new Scene(), { device } = fakeDevice();
    const prepared = scene.prepareAuthoredOwner([{ ...meshData(87, ORIGIN, false), modelIndex: 2 }], device, fakePipeline);
    scene.setModelTranslation(2, [7, 8, 9]);
    assert.throws(() => prepared.commit(), /placement changed/);
    prepared.dispose();
    assert.equal(scene.getMeshDataPieces(87), undefined);
    assert.equal(scene.getBatchedMeshes().length, 0);
  });

});
