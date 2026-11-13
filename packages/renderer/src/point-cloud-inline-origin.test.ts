/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An inline point cloud far from the origin keeps its millimetres when it
 * carries a double-precision `origin` (#10029). Two points 0.1 m apart at
 * x = 2,600,000 m (Swiss LV95) land on one f32 grid step (0.25 m) when the
 * positions are absolute; with an origin they stay 0.1 m apart through the
 * renderer's placement, CPU pick and bounds, and line up with a mesh vertex
 * at the same world coordinate.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData, PointCloudAsset } from '@ifc-lite/geometry';
import { PointCloudRenderer } from './pointcloud/point-cloud-renderer.js';
import { queryPointClouds } from './raycast-point-cloud-query.js';

(globalThis as Record<string, unknown>).GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2 };
(globalThis as Record<string, unknown>).GPUBufferUsage ??= { VERTEX: 32, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
function pointDevice(): GPUDevice {
  return { limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28 }, createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createShaderModule: () => ({}), createRenderPipeline: () => ({}), createBindGroup: () => ({}),
    createBuffer: ({ size }: GPUBufferDescriptor) => ({ size, destroy() {} }), queue: { writeBuffer() {} },
  } as unknown as GPUDevice;
}

// Neither is an f32 value; both round to the same f32 (2,600,000.0).
const WORLD_X = [2_600_000.02, 2_600_000.12];
const CAMERA = { fov: 1.0472, canvasHeightPx: 800, orthoHalfHeight: null };

/** World position the CPU pick returns for a ray straight down onto each point,
 *  from 1 m away so the ~1 cm snap tolerance cannot reach the 0.1 m neighbour. */
function pickWorldX(asset: PointCloudAsset): number[] {
  const renderer = new PointCloudRenderer(pointDevice(), 'rgba8unorm', 'depth32float', 1);
  renderer.addAsset(asset);
  const picks = WORLD_X.map((x) => queryPointClouds(() => renderer.getRayQuerySources(),
    { origin: { x, y: 1, z: 0 }, direction: { x: 0, y: -1, z: 0 } }, CAMERA, 100)?.position.x ?? NaN);
  renderer.clear();
  return picks;
}

function cloud(origin: [number, number, number] | undefined): PointCloudAsset {
  const base = origin?.[0] ?? 0;
  const positions = new Float32Array(WORLD_X.flatMap((x) => [x - base, 0, 0]));
  return { expressId: 1, ...(origin ? { origin } : {}), chunk: { pointCount: 2, positions,
    bbox: { min: [positions[0], 0, 0], max: [positions[3], 0, 0] } } };
}

it('absolute f32 positions at 2,600,000 m collapse two points 0.1 m apart (the #10029 defect)', () => {
  const asset = cloud(undefined);
  assert.equal(asset.chunk.positions[0], asset.chunk.positions[3], 'both points sit on the same 0.25 m f32 grid step');
  assert.equal(asset.chunk.positions[0], 2_600_000, 'and that step is 2 cm and 12 cm from the real points');
  assert.deepEqual(pickWorldX(asset), [NaN, NaN], 'neither real point can be picked within the 1 cm snap tolerance');
});

it('an inline cloud with an f64 origin keeps two points 0.1 m apart at 2,600,000 m (#10029)', () => {
  const origin: [number, number, number] = [WORLD_X[0], 0, 0];
  const [a, b] = pickWorldX(cloud(origin));
  assert.ok(Math.abs(a - WORLD_X[0]) < 1e-4, `first point picked at ${a}`);
  assert.ok(Math.abs(b - WORLD_X[1]) < 1e-4, `second point picked at ${b}`);
  assert.ok(Math.abs(b - a - 0.1) < 1e-4, `picked points are ${b - a} m apart`);

  // Bounds (fit-to-view, model framing) read the same f64 placement.
  const renderer = new PointCloudRenderer(pointDevice(), 'rgba8unorm', 'depth32float', 1);
  const handle = renderer.addAsset(cloud(origin));
  const bounds = renderer.getPlacementBounds(0, handle)!;
  assert.ok(Math.abs(bounds.min[0] - WORLD_X[0]) < 1e-4 && Math.abs(bounds.max[0] - WORLD_X[1]) < 1e-4);
  // The render path draws `rteOrigin + position` (the RTE split happens on that f64 origin).
  const node = renderer.getPickNodes()[0];
  assert.deepEqual(node.rteOrigin, origin);

  // A mesh vertex at the same world coordinate, in the MeshData origin contract
  // (world = origin + positions), coincides with the picked cloud point.
  const mesh: Pick<MeshData, 'origin' | 'positions'> = { origin, positions: new Float32Array([0, 0, 0, WORLD_X[1] - origin[0], 0, 0]) };
  const meshWorldX = mesh.origin![0] + mesh.positions[3];
  assert.ok(Math.abs(meshWorldX - b) < 1e-4, `mesh vertex ${meshWorldX} vs cloud point ${b}`);
  renderer.clear();
});

it('composes a model translation on top of the origin, without losing it (#10029)', () => {
  const renderer = new PointCloudRenderer(pointDevice(), 'rgba8unorm', 'depth32float', 1);
  renderer.setModelTranslation(0, [0.5, 0, 0]);
  const handle = renderer.addAsset(cloud([WORLD_X[0], 0, 0]));
  assert.equal(renderer.getAssetPlacement(handle)![12], WORLD_X[0] + 0.5);
  renderer.setModelTranslation(0, [0, 0, 0]);
  assert.equal(renderer.getAssetPlacement(handle)![12], WORLD_X[0], 'clearing the move keeps the origin');
  renderer.clear();
});
