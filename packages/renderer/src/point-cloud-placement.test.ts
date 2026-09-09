/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from './index.js';
import { PointCloudRenderer } from './pointcloud/point-cloud-renderer.js';
import { PointCloudPlacements } from './pointcloud/point-cloud-placement.js';
import { transformAabb, type PointCloudNode } from './pointcloud/point-cloud-node.js';

  (globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
  (globalThis as Record<string, unknown>).GPUBufferUsage = { VERTEX: 32, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
function pointDevice(): GPUDevice {
  return { limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28 }, createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createShaderModule: () => ({}), createRenderPipeline: () => ({}), createBindGroup: () => ({}),
    createBuffer: ({ size }: GPUBufferDescriptor) => ({ size, destroy() {} }), queue: { writeBuffer() {} },
  } as unknown as GPUDevice;
}

describe('pointcloud import/manual transform composition (#4226)', () => {
  it('cancels a large decode origin before narrowing and retains correction across realignment', () => {
    const node = { model: undefined } as unknown as PointCloudNode;
    const placements = new PointCloudPlacements();
    const baseline = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10_000_000.001, 0, 0, 1]);
    placements.align(node, baseline);
    placements.translate(node, [-10_000_000, 0, 0]);
    const bounds = transformAabb({ min: [0, 0, 0], max: [1, 1, 1] }, node.model);
    assert.ok(Math.abs(bounds.min[0] - 0.001) < 1e-7);
    baseline[12] = 10_000_002;
    placements.align(node, baseline);
    assert.equal(transformAabb({ min: [0, 0, 0], max: [1, 1, 1] }, node.model).min[0], 2);
    placements.translate(node, [0, 0, 0]);
    assert.equal(node.model![12], 10_000_002);
  });

  it('does not share placement between assets or accept non-finite input', () => {
    const a = {} as PointCloudNode, b = {} as PointCloudNode, placements = new PointCloudPlacements();
    placements.translate(a, [5, 2, 3]);
    placements.translate(b, [-3, 0, 0]);
    assert.equal(a.model![12], 5);
    assert.equal(b.model![12], -3);
    assert.throws(() => placements.translate(a, [NaN, 0, 0]), /finite/);
    assert.equal(a.model![12], 5);
    assert.throws(() => placements.translate(a, [1e100, 0, 0]), /range/);
    placements.align(a, null);
    assert.equal(a.model![12], 5, 'rejected translation cannot poison subsequent alignment');
    const overflow = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1e100, 0, 0, 1]);
    assert.throws(() => placements.align(a, overflow), /range/);
    placements.translate(a, [6, 0, 0]);
    assert.equal(a.model![12], 6, 'rejected alignment cannot poison subsequent translation');
  });
});

it('keeps inline scan placement after resource-only clearing (#4226)', () => {
  const renderer = new PointCloudRenderer(pointDevice(), 'rgba8unorm', 'depth32float', 1);
  renderer.setModelTranslation(7, [10, 20, 30]);
  renderer.clear();
  const handle = renderer.addAsset({ expressId: 1, modelIndex: 7, chunk: { pointCount: 1,
    positions: new Float32Array([1, 2, 3]), bbox: { min: [1, 2, 3], max: [1, 2, 3] } } });
  assert.deepEqual(renderer.getPlacementBounds(7, handle), { min: [11, 22, 33], max: [11, 22, 33] });
  renderer.clear();
});

for (const replace of [false, true]) it(`retains a pre-init model offset for embedded clouds (replace: ${replace}, #4226)`, () => {
  const device = pointDevice();
  const renderer = new Renderer({ width: 256, height: 256, getBoundingClientRect: () => ({ width: 256, height: 256 }) } as unknown as HTMLCanvasElement);
  renderer.setModelTranslation(7, [100, 200, 300]);
  // Device creation boundary: the actual point renderer is created after the
  // public placement call, just as it is after Renderer.init's device await.
  const points = new PointCloudRenderer(device, 'rgba8unorm', 'depth32float', 1);
  (renderer as unknown as { pointCloudRenderer: PointCloudRenderer }).pointCloudRenderer = points;
  const assets = [{ expressId: 1, modelIndex: 7, chunk: { pointCount: 1,
    positions: new Float32Array([1, 2, 3]), bbox: { min: [1, 2, 3] as [number, number, number], max: [1, 2, 3] as [number, number, number] } } }];
  if (replace) renderer.setPointClouds(assets); else renderer.addPointClouds(assets);
  assert.deepEqual(renderer.getModelPlacementBounds(7), { min: { x: 101, y: 202, z: 303 }, max: { x: 101, y: 202, z: 303 } });
  points.clear();
});

it('rejects invalid deferred cloud offsets before a later upload can inherit them (#4226)', () => {
  const renderer = new PointCloudRenderer(pointDevice(), 'rgba8unorm', 'depth32float', 1);
  renderer.setModelTranslation(7, [5, 6, 7]);
  for (const invalid of [NaN, Infinity, 1e100]) assert.throws(() => renderer.setModelTranslation(7, [invalid, 0, 0]), /finite/);
  for (const index of [-1, 0.5, Infinity, NaN]) assert.throws(() => renderer.setModelTranslation(index, [0, 0, 0]), /model index/);
  assert.equal(renderer.getNodeCount(), 0);
  const handle = renderer.addAsset({ expressId: 1, modelIndex: 7, chunk: { pointCount: 1,
    positions: new Float32Array([1, 2, 3]), bbox: { min: [1, 2, 3], max: [1, 2, 3] } } });
  assert.deepEqual(renderer.getPlacementBounds(7, handle), { min: [6, 8, 10], max: [6, 8, 10] });
  assert.throws(() => renderer.setModelTranslation(7, [NaN, 0, 0]), /finite/);
  assert.deepEqual(renderer.getPlacementBounds(7, handle), { min: [6, 8, 10], max: [6, 8, 10] });
  const later = renderer.addAsset({ expressId: 2, modelIndex: 7, chunk: { pointCount: 1,
    positions: new Float32Array([0, 0, 0]), bbox: { min: [0, 0, 0], max: [0, 0, 0] } } });
  assert.deepEqual(renderer.getPlacementBounds(7, later), { min: [5, 6, 7], max: [5, 6, 7] });
  assert.equal(renderer.getNodeCount(), 2); renderer.clear();
});

it('preflights all composed cloud matrices before moving any scene geometry (#4226)', () => {
  const renderer = new Renderer({ width: 256, height: 256, getBoundingClientRect: () => ({ width: 256, height: 256 }) } as unknown as HTMLCanvasElement);
  const points = new PointCloudRenderer(pointDevice(), 'rgba8unorm', 'depth32float', 1);
  (renderer as unknown as { pointCloudRenderer: PointCloudRenderer }).pointCloudRenderer = points;
  const asset = (id: number) => ({ expressId: id, modelIndex: 7, chunk: { pointCount: 1,
    positions: new Float32Array([0, 0, 0]), bbox: { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] } } });
  const first = points.addAsset(asset(1)), second = points.addAsset(asset(2));
  const alignment = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3e38, 0, 0, 1]);
  points.setAssetTransform(second, alignment);
  const before = renderer.getModelPlacementBounds(7);
  assert.throws(() => renderer.setModelTranslation(7, [1e38, 0, 0]), /range/);
  assert.deepEqual(renderer.getModelPlacementBounds(7), before);
  assert.deepEqual(points.getPlacementBounds(7, first), { min: [0, 0, 0], max: [0, 0, 0] });
  const third = points.addAsset(asset(3));
  assert.deepEqual(points.getPlacementBounds(7, third), { min: [0, 0, 0], max: [0, 0, 0] });
  const scene = (renderer as unknown as { scene: { getModelTranslation(index: number): readonly number[] } }).scene;
  assert.deepEqual(scene.getModelTranslation(7), [0, 0, 0]);
  renderer.setModelTranslation(7, [-1e38, 0, 0]);
  assert.equal(points.getPickNodes()[0].model?.[12], Math.fround(-1e38), 'GPU picking receives the visible placement matrix');
  points.clear();
});
