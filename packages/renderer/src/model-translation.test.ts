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
      const buffer = { size, data: new ArrayBuffer(size), writes: 0,
        getMappedRange() { return this.data; }, unmap() {}, destroy() {} };
      buffers.push(buffer);
      return buffer;
    },
    createBindGroup() { return {}; },
    queue: { writeBuffer() { throw new Error('Flat translation must not upload vertices.'); } },
  } as unknown as GPUDevice;
  const pipeline = { getUniformBufferSize: () => 512, getBindGroupLayout: () => ({}) } as unknown as RenderPipeline;
  return { device, pipeline, buffers };
}

describe('whole-model renderer placement (#4226)', () => {
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

  it('keeps same-colour overrides attached to their own federated model', () => {
    const scene = new Scene(), { device, pipeline } = recordingGpu();
    scene.appendToBatches([triangle(1, 0), triangle(2, 1, 3)], device, pipeline);
    scene.setColorOverrides(new Map([[1, [1, 0, 0, 1]], [2, [1, 0, 0, 1]]]), device, pipeline);
    const overlays = scene.getOverrideBatches();
    assert.equal(overlays.length, 2);
    const before = overlays.map((batch) => ({ batch, origin: batch.origin![0], buffer: batch.vertexBuffer }));
    scene.setModelTranslation(1, [10, 0, 0]);
    for (const { batch, origin, buffer } of before) {
      const expectedModel = batch.expressIds.includes(2) ? 1 : 0;
      assert.ok([...batch.modelIndices!].every((index) => index === expectedModel));
      assert.equal(batch.origin![0], origin + (expectedModel === 1 ? 10 : 0));
      assert.equal(batch.vertexBuffer, buffer, 'overlay movement does not rebuild its geometry');
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
});
