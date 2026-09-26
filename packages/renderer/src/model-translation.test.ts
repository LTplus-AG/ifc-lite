/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import { Renderer } from './index.js';
import { ModelTranslations } from './model-translation.js';
import { MathUtils } from './math.js';
import type { Mesh } from './types.js';
import { modelPlacementBounds } from './model-placement-bounds.js';
import type { RenderPipeline } from './pipeline.js';
import { buildGeometryCache } from './snap-geometry-cache.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128,
};

function triangle(expressId: number, modelIndex: number, x = 0): MeshData {
  return { expressId, modelIndex, origin: [x, 0, 0], color: [1, 1, 1, 1],
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]) };
}

function recordingGpu() {
  const buffers: Array<{ data: ArrayBuffer; writes: number }> = [];
  const device = {
    limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28 },
    createBuffer({ size }: GPUBufferDescriptor) {
      const buffer = { size, data: new ArrayBuffer(size), writes: 0, destroy() {} };
      buffers.push(buffer);
      return buffer;
    },
    createBindGroup() { return {}; },
    queue: {
      // The ONLY write allowed is a new buffer's initial fill, issued right
      // after its allocation (`createStaticGpuBuffer`, #5429). Rewriting any
      // existing buffer is a vertex re-upload, which flat translation must
      // never do.
      writeBuffer(target: { data: ArrayBuffer; writes: number }, offset: number, data: ArrayBufferView) {
        if (target !== buffers[buffers.length - 1] || target.writes > 0) {
          throw new Error('Flat translation must not upload vertices.');
        }
        target.writes++;
        new Uint8Array(target.data, offset).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      },
    },
  } as unknown as GPUDevice;
  const pipeline = { getUniformBufferSize: () => 512, getBindGroupLayout: () => ({}) } as unknown as RenderPipeline;
  return { device, pipeline, buffers };
}

describe('whole-model renderer placement (#4226)', () => {
  it('uploads extracted merged geometry in its source batch frame without losing the RTE anchor (#5010, #5049)', () => {
    const renderer = new Renderer({ width: 256, height: 256,
      getBoundingClientRect: () => ({ width: 256, height: 256 }) } as unknown as HTMLCanvasElement);
    const uploaded = new WeakMap<GPUBuffer, ArrayBuffer>();
    const device = {
      limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28 },
      createBuffer({ size }: GPUBufferDescriptor) {
        const bytes = new ArrayBuffer(size);
        const buffer = { size, destroy() {} } as unknown as GPUBuffer;
        uploaded.set(buffer, bytes);
        return buffer;
      },
      createBindGroup() { return {}; },
      queue: { writeBuffer(buffer: GPUBuffer, offset: number, data: AllowSharedBufferSource) {
        const target = uploaded.get(buffer)!;
        const source = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        new Uint8Array(target, offset, source.byteLength).set(source);
      } },
    } as unknown as GPUDevice;
    const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as RenderPipeline;
    const internals = renderer as unknown as { device: { isInitialized(): boolean; getDevice(): GPUDevice }; pipeline: RenderPipeline };
    internals.device = { isInitialized: () => true, getDevice: () => device };
    internals.pipeline = pipeline;
    const scene = renderer.getScene() as Scene;
    scene.setSpatialChunking({ cellSize: 32 });
    scene.setQuantizedBatches(true);
    const near = triangle(1, 0, 0);
    const merged = { ...triangle(7, 4, 800_000_000), entityIds: new Uint32Array([7, 7, 7]) } as MeshData;
    scene.appendToBatches([near, merged], device, pipeline);
    const extracted = scene.getMeshDataPieces(7, 4)![0];
    const source = scene.getBatchedMeshes().find((batch) => batch.expressIds.includes(7))!;

    renderer.createMeshFromData(extracted);
    const hydrated = scene.getMeshes().find((mesh) => mesh.hydrated && mesh.expressId === 7)!;
    const bytes = uploaded.get(hydrated.vertexBuffer)!;
    const written = new Float32Array(bytes);
    const origin = source.origin!;
    const relative = Math.fround(extracted.positions[0] + extracted.origin![0] - origin[0]);
    const expected = Math.round(relative * 1024) / 1024;
    assert.strictEqual(written[0], expected,
      'the real upload retains the source batch-relative quantized lattice');
    assert.deepEqual(hydrated.rteOrigin, origin,
      'the canonical 800,000 km source anchor reaches the RTE draw instead of being folded into f32 vertices');
  });

  for (const streaming of [false, true]) it(`frames later uploads in their pre-existing placement (streaming: ${streaming}, #4226)`, () => {
    const { device, pipeline } = recordingGpu();
    const canvas = { width: 256, height: 256, getBoundingClientRect: () => ({ width: 256, height: 256 }) } as unknown as HTMLCanvasElement;
    const renderer = new Renderer(canvas);
    // Only the GPU boundary is replaced; Renderer, Scene, batching and the
    // camera's bounds tracker execute their actual upload paths.
    const internals = renderer as unknown as Record<string, unknown>;
    internals.device = { isInitialized: () => true, getDevice: () => device };
    internals.pipeline = pipeline;
    renderer.setModelTranslation(7, [10_000, 0, 0]);
    const first = triangle(1, 7);
    if (streaming) renderer.addMeshes([first], true); else renderer.loadGeometry([first]);
    assert.deepEqual(renderer.getModelBounds(), { min: { x: 10_000, y: 0, z: 0 }, max: { x: 10_001, y: 1, z: 0 } });
    renderer.addMeshes([triangle(2, 7, 5)], streaming);
    assert.deepEqual(renderer.getModelBounds(), { min: { x: 10_000, y: 0, z: 0 }, max: { x: 10_006, y: 1, z: 0 } });
    renderer.fitToView();
    assert.deepEqual(renderer.getCamera().getTarget(), { x: 10_003, y: 0.5, z: 0 });
    assert.deepEqual(first.origin, [0, 0, 0], 'incremental bounds do not mutate source coordinates');
  });
  it('moves picking and snap vertices with the model while preserving source geometry', () => {
    const scene = new Scene(), source = triangle(1, 0);
    scene.addMeshData(source);
    const direction = { x: 0, y: 0, z: -1 };
    assert.equal(scene.raycast({ x: 0.2, y: 0.2, z: 2 }, direction)?.expressId, 1);
    scene.setModelTranslation(0, [10, 0, 0]);
    assert.equal(scene.raycast({ x: 0.2, y: 0.2, z: 2 }, direction), null);
    assert.equal(scene.raycast({ x: 10.2, y: 0.2, z: 2 }, direction)?.expressId, 1);
    const placed = scene.getMeshDataPieces(1)![0];
    assert.ok(buildGeometryCache(placed).vertices.some((point) => point.x === 10));
    assert.strictEqual(placed.positions, source.positions, 'no vertex copy');
    assert.deepEqual(source.origin, [0, 0, 0], 'source export frame unchanged');
    scene.setModelTranslation(0, [0, 0, 0]);
    assert.equal(scene.raycast({ x: 0.2, y: 0.2, z: 2 }, direction)?.expressId, 1);
  });

  it('separates same-colour models and moves batch origins without rebuilding GPU buffers', () => {
    const scene = new Scene(), { device, pipeline, buffers } = recordingGpu();
    scene.appendToBatches([triangle(1, 0), triangle(2, 1, 3)], device, pipeline);
    const before = scene.getBatchedMeshes().map((batch) => ({ batch, vertexBuffer: batch.vertexBuffer,
      origin: [...batch.origin!], bounds: structuredClone(batch.bounds!) }));
    assert.equal(before.length, 2);
    const bufferCount = buffers.length;
    scene.setModelTranslation(1, [10, 0, 0]);
    for (const item of before) {
      assert.strictEqual(item.batch.vertexBuffer, item.vertexBuffer);
      const expectedModel = item.batch.expressIds.includes(2) ? 1 : 0;
      assert.ok([...item.batch.modelIndices!].every((index) => index === expectedModel));
      const delta = expectedModel === 1 ? 10 : 0;
      assert.equal(item.batch.origin![0], item.origin[0] + delta);
      assert.equal(item.batch.bounds!.min[0], item.bounds.min[0] + delta);
    }
    assert.equal(buffers.length, bufferCount, 'preview allocates no GPU geometry');
    assert.equal(scene.getEntityBoundingBox(2)?.min.x, 13);
  });

  it('keeps same-colour overrides attached to their own federated model', async () => {
    const colorTable = await import('./entity-color-table.js').catch(() => null);
    assert.ok(colorTable, 'the renderer provides the entity colour table');
    const { lookupEntityColor } = colorTable;
    const scene = new Scene(), { device, pipeline, buffers } = recordingGpu();
    scene.appendToBatches([triangle(1, 0), triangle(2, 1, 3)], device, pipeline);
    const allocated = buffers.length;
    scene.setColorOverrides(new Map([[1, [1, 0, 0, 1]], [2, [1, 0, 0, 1]]]), device, pipeline);
    // #6076: the override is a colour-table entry, so the only allocation is
    // the table; the base batch that moves with its model is what gets painted.
    assert.equal(buffers.length, allocated + 1, 'no overlay geometry is allocated');
    const before = scene.getBatchedMeshes().map((batch) => ({ batch, origin: batch.origin![0], buffer: batch.vertexBuffer }));
    scene.setModelTranslation(1, [10, 0, 0]);
    for (const { batch, origin, buffer } of before) {
      const expectedModel = batch.expressIds.includes(2) ? 1 : 0;
      assert.ok([...batch.modelIndices!].every((index) => index === expectedModel));
      assert.equal(batch.origin![0], origin + (expectedModel === 1 ? 10 : 0));
      assert.equal(batch.vertexBuffer, buffer, 'translation does not rebuild the painted batch');
      assert.deepEqual(lookupEntityColor(scene.getEntityColorTable().getImage(), batch.expressIds[0]), [1, 0, 0, 1]);
    }
  });

  it('moves authored non-batched meshes without evicting them, and places later uploads', () => {
    const scene = new Scene(), { device } = recordingGpu();
    const authored = (id: number, modelIndex: number, x: number): Mesh => {
      const transform = MathUtils.identity(); transform.m[12] = x;
      return { expressId: id, modelIndex, transform, color: [1, 1, 1, 1], indexCount: 3,
        vertexBuffer: device.createBuffer({ size: 36, usage: GPUBufferUsage.VERTEX }),
        indexBuffer: device.createBuffer({ size: 12, usage: GPUBufferUsage.INDEX }),
        bounds: { min: [x, 0, 0], max: [x + 1, 1, 0] } };
    };
    const moving = authored(1, 7, 3), fixed = authored(2, 8, 5);
    scene.addMeshData(triangle(1, 7, 3)); scene.addMesh(moving); scene.addMesh(fixed);
    const highlight = { ...authored(1, 7, 3), hydrated: true }; scene.addMesh(highlight);
    const vertexBuffer = moving.vertexBuffer;
    scene.setModelTranslation(7, [10, 20, 30]);
    assert.deepEqual(scene.getMeshes(), [moving, fixed], 'only the hydrated highlight is discarded');
    assert.equal(moving.vertexBuffer, vertexBuffer);
    assert.deepEqual(Array.from(moving.transform.m.slice(12, 15)), [13, 20, 30]);
    assert.deepEqual(Array.from(fixed.transform.m.slice(12, 15)), [5, 0, 0]);
    assert.deepEqual(modelPlacementBounds(scene, null, 7), { min: { x: 13, y: 20, z: 30 }, max: { x: 14, y: 21, z: 30 } });
    assert.equal(scene.raycast({ x: 13.2, y: 20.2, z: 32 }, { x: 0, y: 0, z: -1 })?.expressId, 1);
    scene.releaseGeometryData();
    scene.setModelTranslation(7, [20, 0, 0]);
    assert.equal(scene.getEntityBoundingBox(1)!.min.x, 23, 'released CPU pick bounds follow the authored mesh');
    scene.setModelTranslation(7, [10, 20, 30]);
    const late = authored(3, 7, 8); scene.addMesh(late);
    assert.deepEqual(Array.from(late.transform.m.slice(12, 15)), [18, 20, 30]);
    scene.setModelTranslation(7, [0, 0, 0]);
    assert.equal(moving.transform.m[12], 3); assert.equal(late.transform.m[12], 8);
  });

  it('moves both completed and pending batches during asynchronous finalization', async () => {
    const scene = new Scene(), { device, pipeline } = recordingGpu();
    const a = triangle(1, 1), b = { ...triangle(2, 1, 3), color: [1, 0, 0, 1] as [number, number, number, number] };
    scene.appendToBatches([a, b], device, pipeline, true);
    // budget=0 builds one replacement synchronously, then yields before the
    // second; both old drawables and the unexposed replacement must move.
    const finalizing = scene.finalizeStreamingAsync(device, pipeline, 0);
    scene.setModelTranslation(1, [100, 0, 0]);
    await finalizing;
    for (const batch of scene.getBatchedMeshes()) {
      assert.equal(batch.bounds!.min[0], batch.expressIds.includes(2) ? 103 : 100);
    }
    assert.equal(scene.raycast({ x: 103.2, y: 0.2, z: 2 }, { x: 0, y: 0, z: -1 })?.expressId, 2);
  });

  it('restores cold geometry through source bounds and uploads its current placement', async () => {
    const scene = new Scene(), { device, pipeline } = recordingGpu(), source = triangle(1, 1, 3);
    scene.appendToBatches([source], device, pipeline);
    scene.setColdGeometryProvider({ loadMeshesInBounds: async (min, max) => {
      assert.deepEqual(min, [3, 0, 0]); assert.deepEqual(max, [4, 1, 0]);
      return [source];
    } });
    scene.setGpuResidencyBudget(1); scene.setHostResidencyBudget(1);
    for (let i = 0; i < 1000; i++) scene.beginResidencyFrame();
    for (let i = 0; i < 240; i++) scene.enforceGpuBudget();
    assert.equal(scene.getMeshDataPieces(1), undefined, 'CPU geometry was evicted to the real cold tier');
    scene.setModelTranslation(1, [1000, 0, 0]);
    await scene.drainColdTier();
    assert.equal(scene.restoreAllEvicted(device, pipeline), 1);
    assert.equal(scene.getBatchedMeshes()[0].bounds!.min[0], 1003, 'GPU restoration uses the placed bucket mesh');
    assert.equal(scene.raycast({ x: 1003.2, y: 0.2, z: 2 }, { x: 0, y: 0, z: -1 })?.expressId, 1);
    assert.deepEqual(source.origin, [3, 0, 0]);
  });

  it('preserves each released contribution when models temporarily share an entity id', () => {
    const scene = new Scene(), { device, pipeline } = recordingGpu();
    scene.appendToBatches([triangle(1, 0), triangle(1, 1, 3)], device, pipeline);
    scene.releaseGeometryData();
    scene.setModelTranslation(1, [100, 0, 0]);
    assert.equal(scene.getEntityBoundingBox(1)!.min.x, 0);
    assert.equal(scene.getEntityBoundingBox(1)!.max.x, 104);
    assert.equal(scene.raycast({ x: 0.2, y: 0.2, z: 2 }, { x: 0, y: 0, z: -1 })?.expressId, 1);
    scene.setModelTranslation(0, [-10, 0, 0]);
    assert.equal(scene.getEntityBoundingBox(1)!.min.x, -10);
    assert.equal(scene.getEntityBoundingBox(1)!.max.x, 104);
  });

  it('moves GPU-resident geometry and cached pick bounds after CPU release', () => {
    const scene = new Scene(), { device, pipeline } = recordingGpu();
    scene.appendToBatches([triangle(1, 0, 0.125), triangle(2, 1, 5)], device, pipeline);
    scene.releaseGeometryData();
    assert.equal(scene.isGeometryDataReleased(), true);
    for (let i = 0; i < 100; i++) {
      scene.setModelTranslation(0, [10_000_000, 0, 0]);
      scene.setModelTranslation(0, [0.001, 0, 0]);
      assert.ok(Math.abs(scene.getEntityBoundingBox(1)!.min.x - 0.126) < 1e-10);
      assert.equal(scene.getEntityBoundingBox(2)!.min.x, 5);
    }
    scene.setModelTranslation(0, [0, 0, 0]);
    assert.equal(scene.getEntityBoundingBox(1)!.min.x, 0.125);
    assert.equal(scene.raycast({ x: 0.2, y: 0.2, z: 2 }, { x: 0, y: 0, z: -1 })?.expressId, 1);
  });

  it('gives distant models separate local GPU frames', () => {
    const scene = new Scene(), { device, pipeline } = recordingGpu();
    scene.appendToBatches([triangle(1, 0), triangle(2, 1, 10_000_000.001)], device, pipeline);
    const batches = scene.getBatchedMeshes();
    assert.ok(Math.abs(batches[1].origin![0] - batches[0].origin![0]) > 9_000_000);
    scene.setModelTranslation(1, [-10_000_000, 0, 0]);
    assert.ok(Math.abs(scene.getEntityBoundingBox(2)!.min.x - 0.001) < 1e-7);
    assert.equal(scene.getEntityBoundingBox(1)!.min.x, 0);
  });

  it('retains fine residuals when moving a georeferenced model near zero and rebuilding', () => {
    const scene = new Scene(), { device, pipeline } = recordingGpu();
    const source = triangle(1, 0, 10_000_000);
    scene.appendToBatches([source], device, pipeline);
    scene.setModelTranslation(0, [-10_000_000 + 0.001, 0, 0]);
    assert.ok(Math.abs(scene.getBatchedMeshes()[0].bounds!.min[0] - 0.001) < 0.0001);
    scene.clearFlatGeometry();
    scene.appendToBatches([source], device, pipeline);
    assert.ok(Math.abs(scene.getBatchedMeshes()[0].bounds!.min[0] - 0.001) < 0.0001);
    assert.equal(source.origin![0], 10_000_000);
  });

  it('applies current placement to newly arriving geometry and resets at full teardown', () => {
    const scene = new Scene();
    scene.setModelTranslation(1, [4, 5, 6]);
    scene.addMeshData(triangle(1, 1));
    assert.deepEqual(scene.getEntityBoundingBox(1)?.min, { x: 4, y: 5, z: 6 });
    scene.clear();
    scene.addMeshData(triangle(1, 1));
    assert.deepEqual(scene.getEntityBoundingBox(1)?.min, { x: 0, y: 0, z: 0 });
  });

  it('reconstructs instance translation from a double baseline after coarse previews', () => {
    const translations = new ModelTranslations(), data = new ArrayBuffer(88), view = new DataView(data);
    view.setFloat32(48, 0.125, true);
    translations.placeInstances(data, 0, 88);
    for (let i = 0; i < 100; i++) {
      translations.set(0, [10_000_000, 0, 0]);
      translations.placeInstances(data, 0, 88);
      translations.set(0, [0.001, 0, 0]);
      translations.placeInstances(data, 0, 88);
      assert.ok(Math.abs(view.getFloat32(48, true) - 0.126) < 1e-7);
    }
    translations.set(0, [0, 0, 0]);
    translations.placeInstances(data, 0, 88);
    assert.equal(view.getFloat32(48, true), 0.125);
  });

  it('reconstructs instance translation from a double baseline through coarse previews of a yaw too (#4890)', () => {
    const translations = new ModelTranslations(), data = new ArrayBuffer(88), view = new DataView(data);
    view.setFloat32(48, 0.125, true);
    translations.placeInstances(data, 0, 88);
    for (let i = 0; i < 100; i++) {
      translations.setYaw(0, { angle: 0.4, px: 1_000_000, pz: -1_000_000 });
      translations.set(0, [10_000_000, 0, 0]);
      translations.placeInstances(data, 0, 88);
      translations.setYaw(0, { angle: -0.7, px: 3, pz: -2 });
      translations.set(0, [0.001, 0, 0]);
      translations.placeInstances(data, 0, 88);
    }
    // Return to zero yaw and zero translation: the double baseline must give
    // back the exact pristine byte, however many rotated previews ran.
    translations.setYaw(0, null);
    translations.set(0, [0, 0, 0]);
    translations.placeInstances(data, 0, 88);
    assert.equal(view.getFloat32(48, true), 0.125);
  });
});

it('moves every released color-merged entity, not only its wrapper id (#4226)', () => {
  const scene = new Scene(), { device, pipeline } = recordingGpu();
  const merged = triangle(100, 7);
  merged.entityIds = new Uint32Array([11, 12, 13]);
  scene.appendToBatches([merged], device, pipeline);
  const before = [11, 12, 13].map((id) => scene.getEntityBoundingBox(id));
  assert.ok(before.every(Boolean));
  scene.releaseGeometryData();
  scene.setModelTranslation(7, [100, 200, 300]);
  for (const [index, id] of [11, 12, 13].entries()) {
    const box = scene.getEntityBoundingBox(id)!;
    assert.equal(box.min.x, before[index]!.min.x + 100);
    assert.equal(box.min.y, before[index]!.min.y + 200);
    assert.equal(box.min.z, before[index]!.min.z + 300);
  }
  scene.setModelTranslation(7, [0, 0, 0]);
  assert.deepEqual([11, 12, 13].map((id) => scene.getEntityBoundingBox(id)), before);
});

it('retains replaced, edited and removed authored bounds across model moves (#4226)', () => {
  const placements = new ModelTranslations();
  const mesh = { modelIndex: 7, transform: MathUtils.identity(), bounds: { min: [0, 0, 0], max: [1, 1, 1] } } as Mesh;
  placements.placeAuthoredMesh(mesh);
  mesh.bounds = { min: [2, 3, 4], max: [5, 6, 7] };
  placements.set(7, [10, 0, 0]); placements.placeAuthoredMesh(mesh);
  assert.deepEqual(mesh.bounds, { min: [12, 3, 4], max: [15, 6, 7] });
  mesh.bounds!.min[1] = -2;
  placements.set(7, [20, 0, 0]); placements.placeAuthoredMesh(mesh);
  assert.deepEqual(mesh.bounds, { min: [22, -2, 4], max: [25, 6, 7] });
  mesh.bounds = undefined;
  placements.set(7, [30, 0, 0]); placements.placeAuthoredMesh(mesh);
  assert.equal(mesh.bounds, undefined);
  mesh.bounds = { min: [32, -2, 4], max: [35, 6, 7] };
  placements.set(7, [0, 0, 0]); placements.placeAuthoredMesh(mesh);
  assert.deepEqual(mesh.bounds, { min: [2, -2, 4], max: [5, 6, 7] });
});

for (const reshape of [false, true]) it(`does not resurrect removed released geometry (reshape: ${reshape}, #4226)`, () => {
  const scene = new Scene(), { device, pipeline } = recordingGpu();
  scene.appendToBatches([triangle(1, 7), triangle(2, 7, 10)], device, pipeline);
  scene.releaseGeometryData();
  if (reshape) {
    scene.clearFlatGeometry(); scene.appendToBatches([triangle(2, 7, 10)], device, pipeline);
  } else scene.removeMeshesForEntity(1);
  scene.releaseGeometryData(); scene.setModelTranslation(7, [100, 0, 0]);
  assert.equal(scene.getEntityBoundingBox(1), null);
  assert.equal(scene.raycast({ x: 100.2, y: 0.2, z: 2 }, { x: 0, y: 0, z: -1 }), null);
  assert.deepEqual(scene.getBounds(), { min: { x: 110, y: 0, z: 0 }, max: { x: 111, y: 1, z: 0 } });
  assert.equal(scene.raycast({ x: 110.2, y: 0.2, z: 2 }, { x: 0, y: 0, z: -1 })?.expressId, 2);
});

describe('ModelTranslations yaw (#4890)', () => {
  const STRIDE = 88;

  /** Write one instance record's 3 linear columns + translation, little-endian,
   *  matching `INSTANCE_STRIDE_BYTES`'s column-major mat4 layout. */
  function writeRecord(view: DataView, cols: [number, number, number][], translation: [number, number, number]): void {
    for (let c = 0; c < 3; c++) for (let a = 0; a < 3; a++) view.setFloat32(c * 16 + a * 4, cols[c][a], true);
    for (let a = 0; a < 3; a++) view.setFloat32(48 + a * 4, translation[a], true);
  }

  /** `instMat * (local, 1)` read straight off the current bytes. */
  function worldPoint(view: DataView, local: [number, number, number]): [number, number, number] {
    const col = (c: number) => [view.getFloat32(c * 16, true), view.getFloat32(c * 16 + 4, true), view.getFloat32(c * 16 + 8, true)];
    const [c0, c1, c2] = [col(0), col(1), col(2)];
    const t = [view.getFloat32(48, true), view.getFloat32(52, true), view.getFloat32(56, true)];
    return [0, 1, 2].map((i) => local[0] * c0[i] + local[1] * c1[i] + local[2] * c2[i] + t[i]) as [number, number, number];
  }

  it('keeps canonical f64 instance anchors through a centimetre model move at 5,000 km (#5049)', () => {
    const translations = new ModelTranslations(), data = new ArrayBuffer(120), view = new DataView(data);
    writeRecord(view, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [5_000_000, 0, 0]);
    const anchors = new Float64Array([5_000_000.015625, 0, 0]);
    const matrixTranslations = new Float32Array([5_000_000, 0, 0]);
    translations.placeInstances(data, 7, 120, anchors, matrixTranslations);

    translations.set(7, [0.01, 0, 0]);
    translations.placeInstances(data, 7, 120, anchors, matrixTranslations);
    assert.equal(anchors[0], 5_000_000.025625, 'f64 residual survives the model translation');
    assert.equal(matrixTranslations[0], view.getFloat32(48, true), 'materialization baseline follows the V1 matrix write');

    translations.set(7, [0, 0, 0]);
    translations.placeInstances(data, 7, 120, anchors, matrixTranslations);
    assert.equal(anchors[0], 5_000_000.015625, 'undo returns to the exact source anchor');
  });

  it('maps a template corner to the point the yaw formula predicts (37.4deg, off-origin pivot, then translate)', () => {
    const translations = new ModelTranslations(), data = new ArrayBuffer(STRIDE), view = new DataView(data);
    writeRecord(view, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [4, 2, -3]);
    translations.placeInstances(data, 0, STRIDE); // captures the pristine base
    const corner: [number, number, number] = [1, 0.5, -2];
    const worldBefore = worldPoint(view, corner);

    const angle = (37.4 * Math.PI) / 180, px = 5, pz = -3, delta: [number, number, number] = [10, 20, 30];
    translations.setYaw(0, { angle, px, pz });
    translations.set(0, delta);
    translations.placeInstances(data, 0, STRIDE);
    const worldAfter = worldPoint(view, corner);

    // The formula this PR settles on (lifted from `Scene.rotateMeshesForEntity`'s
    // sign): rotate the PRE-rotation world point about the pivot, then add the
    // translate delta — `pivotInModelFrame`'s order — written out here
    // independently of `ModelTranslations.placeInstances`.
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const dx = worldBefore[0] - px, dz = worldBefore[2] - pz;
    const expected: [number, number, number] = [
      px + dx * cos + dz * sin + delta[0],
      worldBefore[1] + delta[1],
      pz - dx * sin + dz * cos + delta[2],
    ];
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(worldAfter[i] - expected[i]) < 1e-3, `axis ${i}: ${worldAfter[i]} vs ${expected[i]}`);
  });

  it('zero yaw restores the exact pristine floats', () => {
    const translations = new ModelTranslations(), data = new ArrayBuffer(STRIDE), view = new DataView(data);
    writeRecord(view, [[1, 0, 0.25], [0, 1, 0], [-0.25, 0, 1]], [4, 2, -3]);
    translations.placeInstances(data, 0, STRIDE);
    const pristine = new Float32Array(data.slice(0));

    translations.setYaw(0, { angle: 1.7, px: -3, pz: 8 });
    translations.set(0, [100, 0, -50]);
    translations.placeInstances(data, 0, STRIDE);
    assert.notDeepStrictEqual(new Float32Array(data.slice(0)), pristine, 'sanity: the rotated preview actually changed bytes');

    translations.setYaw(0, null);
    translations.set(0, [0, 0, 0]);
    translations.placeInstances(data, 0, STRIDE);
    assert.deepStrictEqual(new Float32Array(data.slice(0)), pristine);
  });

  it('an intervening +48 translation edit survives a re-yaw', () => {
    const translations = new ModelTranslations(), data = new ArrayBuffer(STRIDE), view = new DataView(data);
    writeRecord(view, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [1, 1, 1]);
    translations.placeInstances(data, 0, STRIDE);

    const yawA = { angle: 0.5, px: 2, pz: -1 };
    translations.setYaw(0, yawA);
    translations.placeInstances(data, 0, STRIDE);
    const beforeEdit: [number, number, number] = [view.getFloat32(48, true), view.getFloat32(52, true), view.getFloat32(56, true)];

    // An exploded-storey lift (or `Scene.translateInstancedEntity`) writes
    // straight into bytes 48..59, bypassing ModelTranslations entirely.
    const edit: [number, number, number] = [0.75, 3, -1.5];
    view.setFloat32(48, beforeEdit[0] + edit[0], true);
    view.setFloat32(52, beforeEdit[1] + edit[1], true);
    view.setFloat32(56, beforeEdit[2] + edit[2], true);

    // Turn to a DIFFERENT yaw and back — the edit must not be lost or
    // rescaled by the round trip through another rotation.
    translations.setYaw(0, { angle: -1.1, px: 9, pz: 4 });
    translations.placeInstances(data, 0, STRIDE);
    translations.setYaw(0, yawA);
    translations.placeInstances(data, 0, STRIDE);

    const after: [number, number, number] = [view.getFloat32(48, true), view.getFloat32(52, true), view.getFloat32(56, true)];
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(after[i] - (beforeEdit[i] + edit[i])) < 1e-3, `axis ${i}: ${after[i]} vs ${beforeEdit[i] + edit[i]}`);
    }
  });

  it('rejects a finite pivot that overflows to Infinity in the f32 instance buffer', () => {
    const translations = new ModelTranslations(), data = new ArrayBuffer(STRIDE), view = new DataView(data);
    writeRecord(view, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [1, 2, 3]);
    translations.placeInstances(data, 0, STRIDE);
    const pristine = new Float32Array(data.slice(0));

    // 1e100 is a finite JS number but overflows `Math.fround` to Infinity —
    // `placeInstances` would otherwise write it through `setFloat32` and
    // poison every occurrence's bounds (`foldOccurrenceWorldBox`).
    assert.throws(() => translations.setYaw(0, { angle: 0.5, px: 1e100, pz: 0 }), /finite/);
    assert.throws(() => translations.setYaw(0, { angle: 0.5, px: 0, pz: 1e100 }), /finite/);
    assert.strictEqual(translations.getYaw(0), null, 'the rejected pivot must not become the stored yaw');
    translations.placeInstances(data, 0, STRIDE);
    assert.deepStrictEqual(new Float32Array(data.slice(0)), pristine, 'the buffer is untouched by a rejected pivot');
  });

  it('returns a copy from getYaw, so mutating it cannot desync change detection', () => {
    const translations = new ModelTranslations(), data = new ArrayBuffer(STRIDE), view = new DataView(data);
    writeRecord(view, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0]);
    translations.placeInstances(data, 0, STRIDE);
    translations.setYaw(0, { angle: 0.5, px: 1, pz: 2 });
    translations.placeInstances(data, 0, STRIDE);
    const written = view.getFloat32(48, true);

    const borrowed = translations.getYaw(0)!;
    borrowed.angle = 1.5; // a caller mutating the returned object in place
    assert.strictEqual(translations.getYaw(0)!.angle, 0.5, 'the stored yaw is unaffected');

    // Setting the SAME logical yaw again must still be recognized as a real
    // change and rewrite the buffer — it must not compare equal to the
    // caller's mutated (but never stored) copy.
    assert.strictEqual(translations.setYaw(0, { angle: 1.5, px: 1, pz: 2 }), true);
    translations.placeInstances(data, 0, STRIDE);
    assert.notEqual(view.getFloat32(48, true), written);
  });

  it('folds a post-baseline world-frame edit in MODEL frame — a moved door stays attached to its rotated wall, matching the flat bake\'s convention (#4890)', () => {
    // The flat path has no "keep it fixed in world space" mode for anything
    // that survives a re-bake: `applyModelRotation` is "ABSOLUTE, NEVER
    // INCREMENTAL" (rotation-geometry.ts:20-23) — it restores the PRISTINE
    // baseline and re-applies the model's CURRENT angle in one shot
    // (rotation-geometry.ts:159 `restore(geometry, baseline)`), and any
    // displacement that is meant to persist across that re-bake only does so
    // by becoming part of the model-frame baseline (a re-authored mesh is
    // captured "in the model's own UNROTATED frame... turned once on arrival",
    // rotation-bake.ts:54-60, `captureAppendedMeshBaselines`). A translation
    // column is rotated as a POINT about the pivot with the exact same
    // formula flat local-to-world matrices use for their own translation
    // column (`rotatedLocalToWorld`, rotation-geometry.ts:58-71: "the
    // translation column is rotated as a point about the pivot").
    // `translateInstancedEntity` (scene.ts ~1600) adds its delta straight into
    // bytes 48..59 in the RENDERER WORLD FRAME — but the world frame a
    // displacement is EXPRESSED in when it happens says nothing about which
    // frame it must stay FIXED in afterwards: an author nudging a door "5
    // world-units sideways" while the wall faces 90° is nudging it 5 units
    // along the WALL's own depth axis, and if the whole building later turns
    // to -45°, the door has to turn with the wall to stay attached — which is
    // exactly the fold `placeInstances` performs (undo the OLD yaw on the
    // diff, i.e. re-express it in the model's own frame, then let the NEW
    // yaw carry it, same as a freshly-baselined flat mesh).
    const translations = new ModelTranslations(), data = new ArrayBuffer(STRIDE), view = new DataView(data);
    writeRecord(view, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [10, 0, 0]);
    translations.placeInstances(data, 0, STRIDE); // pristine base: (10, 0, 0)

    const yawA = { angle: Math.PI / 2, px: 0, pz: 0 };
    translations.setYaw(0, yawA);
    translations.placeInstances(data, 0, STRIDE); // world translation now ~(0, 0, -10)

    // The "move the door" edit: a world-frame delta written straight into
    // bytes 48..59, exactly like `Scene.translateInstancedEntity`.
    const move: [number, number, number] = [5, 0, 0];
    view.setFloat32(48, view.getFloat32(48, true) + move[0], true);
    view.setFloat32(52, view.getFloat32(52, true) + move[1], true);
    view.setFloat32(56, view.getFloat32(56, true) + move[2], true);

    const yawB = { angle: -Math.PI / 4, px: 0, pz: 0 };
    translations.setYaw(0, yawB);
    translations.placeInstances(data, 0, STRIDE);
    const actual: [number, number, number] = [view.getFloat32(48, true), view.getFloat32(52, true), view.getFloat32(56, true)];

    // MODEL-frame oracle, independent of `placeInstances`: undo yawA on the
    // world delta to recover the door's offset from the wall in the wall's
    // OWN frame, add it to the pristine base, then rotate that combined point
    // by yawB.
    const cosA = Math.cos(yawA.angle), sinA = Math.sin(yawA.angle);
    const foldedX = move[0] * cosA - move[2] * sinA, foldedZ = move[0] * sinA + move[2] * cosA;
    const modelFrameBase: [number, number, number] = [10 + foldedX, 0 + move[1], 0 + foldedZ];
    const cosB = Math.cos(yawB.angle), sinB = Math.sin(yawB.angle);
    const modelFrameExpected: [number, number, number] = [
      modelFrameBase[0] * cosB + modelFrameBase[2] * sinB,
      modelFrameBase[1],
      -modelFrameBase[0] * sinB + modelFrameBase[2] * cosB,
    ];
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(actual[i] - modelFrameExpected[i]) < 1e-3, `axis ${i}: ${actual[i]} vs model-frame ${modelFrameExpected[i]}`);
    }

    // The WORLD-frame alternative (add the edit post-hoc without ever undoing
    // yawA) is numerically distinct here and would let the door slide off the
    // wall as the model keeps turning — the bug this fold exists to avoid.
    const worldFrameWrong: [number, number, number] = [
      10 * cosB + 0 * sinB + move[0], 0 + move[1], -10 * sinB + 0 * cosB + move[2],
    ];
    const distinct = [0, 1, 2].some((i) => Math.abs(modelFrameExpected[i] - worldFrameWrong[i]) > 0.5);
    assert.ok(distinct, 'sanity: the two conventions must actually disagree here');
  });
});

describe('Renderer.setModelRotation skips invalidation on a no-op (#4890 review)', () => {
  function testRenderer(): Renderer {
    return new Renderer({ width: 256, height: 256, getBoundingClientRect: () => ({ width: 256, height: 256 }) } as unknown as HTMLCanvasElement);
  }

  it('reports true on a real change and false when nothing changed', () => {
    const renderer = testRenderer();
    // A no-op BEFORE anything has ever turned this model: `Scene.setModelRotation`
    // canonicalizes angle 0 to "no rotation", which is what a never-rotated
    // model already is.
    assert.equal(renderer.setModelRotation(3, 0, [1, 2, 3]), false);
    assert.equal(renderer.setModelRotation(3, 0.5, [1, 0, 2]), true);
    // The identical call again: the viewer's rotation sync makes this call on
    // every placement update, including a translation-only one that leaves
    // every model's declared heading unchanged.
    assert.equal(renderer.setModelRotation(3, 0.5, [1, 0, 2]), false);
    // A genuinely different pivot IS a change, even at the same angle.
    assert.equal(renderer.setModelRotation(3, 0.5, [1, 0, 9]), true);
    // Clearing a standing rotation is a change; clearing it again is not.
    assert.equal(renderer.setModelRotation(3, 0, [0, 0, 0]), true);
    assert.equal(renderer.setModelRotation(3, 0, [0, 0, 0]), false);
  });
});
