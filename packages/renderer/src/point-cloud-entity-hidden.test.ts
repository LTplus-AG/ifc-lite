/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An inline point cloud whose entity is hidden is neither drawn nor picked,
 * and is drawn again once its id leaves the hidden set (#10215: the hidden
 * `pointclouds` layer of a Rhino .3dm still drew its 848 points). Streamed
 * scans keep their own per-handle visibility and ignore these sets.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { PointCloudAsset } from '@ifc-lite/geometry';
import { PointCloudRenderer, type PointCloudDrawState } from './pointcloud/point-cloud-renderer.js';
import { RelativeToEyeFrame } from './relative-to-eye.js';
import { MathUtils } from './math.js';

(globalThis as Record<string, unknown>).GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2 };
(globalThis as Record<string, unknown>).GPUBufferUsage ??= { VERTEX: 32, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
function pointDevice(): GPUDevice {
  return { limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28, maxComputeWorkgroupsPerDimension: 65535 },
    createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createShaderModule: () => ({}), createRenderPipeline: () => ({}), createBindGroup: () => ({}),
    createBuffer: ({ size }: GPUBufferDescriptor) => ({ size, destroy() {} }), queue: { writeBuffer() {} },
  } as unknown as GPUDevice;
}

function cloud(expressId: number, pointCount: number): PointCloudAsset {
  const positions = new Float32Array(pointCount * 3).map((_, i) => i % 3 === 0 ? i / 3 : 0);
  return { expressId, chunk: { pointCount, positions, bbox: { min: [0, 0, 0], max: [pointCount - 1, 0, 0] } } };
}

/** Point counts of the instanced draws `draw` issues into a recording pass. */
function drawnPointCounts(renderer: PointCloudRenderer, filter: Pick<PointCloudDrawState, 'hiddenIds' | 'isolatedIds'>): number[] {
  const counts: number[] = [];
  const pass = { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {},
    draw(_verts: number, instances: number) { counts.push(instances); } } as unknown as GPURenderPassEncoder;
  const relativeToEyeFrame = new RelativeToEyeFrame();
  relativeToEyeFrame.update({ x: 0, y: 0, z: 0 }, MathUtils.identity(), MathUtils.identity());
  renderer.draw(pass, { viewProj: new Float32Array(16), relativeToEyeFrame, viewport: { width: 800, height: 600 }, ...filter });
  return counts.sort((a, b) => a - b);
}

const HIDDEN_CLOUD = 7; // 848 points, like the Rhino_Logo.3dm cloud
const VISIBLE_CLOUD = 9; // 5 points

it('does not draw or pick an inline cloud whose entity is hidden, and draws it again once shown (#10215)', () => {
  const renderer = new PointCloudRenderer(pointDevice(), 'rgba8unorm', 'depth32float', 1);
  renderer.setAssets([cloud(HIDDEN_CLOUD, 848), cloud(VISIBLE_CLOUD, 5)]);

  const hidden = { hiddenIds: new Set([HIDDEN_CLOUD]) };
  assert.deepEqual(drawnPointCounts(renderer, hidden), [5], 'only the visible cloud is drawn');
  assert.deepEqual(renderer.getPickNodes(hidden).map((n) => n.expressId), [VISIBLE_CLOUD], 'the hidden cloud cannot be clicked');

  const shown = { hiddenIds: new Set<number>() };
  assert.deepEqual(drawnPointCounts(renderer, shown), [5, 848], 'unhiding draws the cloud again');
  assert.deepEqual(renderer.getPickNodes(shown).map((n) => n.expressId).sort(), [HIDDEN_CLOUD, VISIBLE_CLOUD]);
  renderer.clear();
});

it('isolation hides inline clouds outside the isolated set, as it does meshes (#10215)', () => {
  const renderer = new PointCloudRenderer(pointDevice(), 'rgba8unorm', 'depth32float', 1);
  renderer.setAssets([cloud(HIDDEN_CLOUD, 848), cloud(VISIBLE_CLOUD, 5)]);
  assert.deepEqual(drawnPointCounts(renderer, { isolatedIds: new Set([VISIBLE_CLOUD]) }), [5]);
  assert.deepEqual(drawnPointCounts(renderer, { isolatedIds: null }), [5, 848], 'no isolation shows both');
  renderer.clear();
});

it('a streamed scan ignores the entity sets and keeps its per-handle visibility (#10215)', () => {
  const renderer = new PointCloudRenderer(pointDevice(), 'rgba8unorm', 'depth32float', 1);
  const handle = renderer.beginAsset({ expressId: HIDDEN_CLOUD });
  const { chunk } = cloud(HIDDEN_CLOUD, 3);
  renderer.appendChunk(handle, chunk);
  const filter = { hiddenIds: new Set([HIDDEN_CLOUD]), isolatedIds: new Set<number>() };
  assert.deepEqual(drawnPointCounts(renderer, filter), [3]);
  assert.deepEqual(renderer.getPickNodes(filter).map((n) => n.expressId), [HIDDEN_CLOUD]);
  renderer.setAssetVisible(handle, false);
  assert.deepEqual(drawnPointCounts(renderer, {}), [], 'hiding the scan model still hides it');
  renderer.clear();
});
