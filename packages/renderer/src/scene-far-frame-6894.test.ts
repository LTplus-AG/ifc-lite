/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Batch frames and the scan-to-BIM detection overlay (#6894).
 *
 * The overlay of a georeferenced scan sits at map coordinates (~1e6 m) while
 * model 0 may hold geometry near the render origin. Batches store float32
 * offsets from one frame per bucket, and model 0's buckets share a frame, so
 * an overlay batched into model 0 is rounded by 0.125-0.5 m (or, drawn first,
 * pins model 0's frame at map coordinates). The overlay therefore draws as
 * its own model index (`SCAN_OVERLAY_MODEL_INDEX` in the viewer's
 * `detection-overlay.ts`): its own buckets and its own shared frame, while
 * every other mesh keeps exactly main's routing.
 *
 * 1. Ordinary content with spatial chunking off (the renderer default) keeps
 *    main's batch count for a 40 km model in any order: no per-mesh frame
 *    splits (a distance rule in the shared routing multiplied draw calls).
 * 2. The overlay and near-origin model-0 geometry both reach the GPU within
 *    1 mm of their float64 positions, in either draw order.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import type { BatchedMesh } from './types.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

/** Fake device that keeps every uploaded byte so batches can be read back. */
function fakeDevice(): { device: GPUDevice; bytes: WeakMap<GPUBuffer, ArrayBuffer> } {
  const bytes = new WeakMap<GPUBuffer, ArrayBuffer>();
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: (desc: GPUBufferDescriptor) => {
      const buffer = { size: desc.size, destroy() {} } as unknown as GPUBuffer;
      bytes.set(buffer, new ArrayBuffer(desc.size));
      return buffer;
    },
    createBindGroup: () => ({}),
    queue: {
      writeBuffer: (buffer: GPUBuffer, offset: number, data: ArrayBufferView) => {
        new Uint8Array(bytes.get(buffer)!, offset).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      },
    },
  };
  return { device: device as unknown as GPUDevice, bytes };
}

const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as Parameters<Scene['appendToBatches']>[2];

/**
 * The overlay's wall group: four 5 x 2.6 m (and 4 x 2.6 m) faces of a room,
 * relative to `origin` (Y up). Large triangles: a far frame does not collapse
 * them, so only the position error shows what the frame costs.
 */
function overlayMesh(expressId: number, origin: [number, number, number], color: [number, number, number, number]): MeshData {
  const positions: number[] = [], indices: number[] = [];
  const quad = (q: number[][]) => {
    const base = positions.length / 3;
    for (const p of q) positions.push(...p);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  quad([[0.013, 0, -0.021], [5.017, 0, -0.021], [5.017, 2.6, -0.021], [0.013, 2.6, -0.021]]);
  quad([[0.013, 0, -4.029], [5.017, 0, -4.029], [5.017, 2.6, -4.029], [0.013, 2.6, -4.029]]);
  quad([[0.013, 0, -0.021], [0.013, 0, -4.029], [0.013, 2.6, -4.029], [0.013, 2.6, -0.021]]);
  quad([[5.017, 0, -0.021], [5.017, 0, -4.029], [5.017, 2.6, -4.029], [5.017, 2.6, -0.021]]);
  return {
    expressId, positions: new Float32Array(positions), normals: new Float32Array(positions.length).fill(0.5),
    indices: new Uint32Array(indices), color, origin,
  };
}

function nearMesh(expressId: number): MeshData {
  return {
    expressId,
    positions: new Float32Array([0.3, 0.7, 0.1, 4.4, 0.7, 0.1, 0.3, 3.9, 0.1]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [0.5, 0.5, 0.5, 1],
    // Absolute positions near the render origin, as a legacy / native mesh without a local frame.
  };
}

/** Worst |batch origin + GPU value − float64 position| over `mesh`'s vertices, in metres. */
function worstError(scene: Scene, bytes: WeakMap<GPUBuffer, ArrayBuffer>, mesh: MeshData): number {
  const batch: BatchedMesh | undefined = scene.getBatchedMeshes().find((b) => b.expressIds.includes(mesh.expressId));
  assert.ok(batch, `a batch holds ${mesh.expressId}`);
  const buf = bytes.get(batch.vertexBuffer)!;
  const u32 = new Uint32Array(buf);
  const gpu: number[][] = [];
  if (batch.quantized) {
    const u16 = new Uint16Array(buf);
    const { min, step } = batch.quantized;
    for (let v = 0; v * 12 < buf.byteLength; v++) {
      if ((u32[v * 3 + 2] & 0xFFFFFF) === mesh.expressId) gpu.push([0, 1, 2].map((a) => Math.fround(min[a] + u16[v * 6 + a] * step)));
    }
  } else {
    const f32 = new Float32Array(buf);
    for (let b = 0; b + 7 <= f32.length; b += 7) if ((u32[b + 6] & 0xFFFFFF) === mesh.expressId) gpu.push([f32[b], f32[b + 1], f32[b + 2]]);
  }
  assert.equal(gpu.length, mesh.positions.length / 3);
  const frame = batch.origin ?? [0, 0, 0];
  let worst = 0;
  gpu.forEach((p, v) => {
    for (let a = 0; a < 3; a++) {
      const expected = (mesh.origin?.[a] ?? 0) + mesh.positions[v * 3 + a];
      worst = Math.max(worst, Math.abs(frame[a] + p[a] - expected));
    }
  });
  return worst;
}

/** The viewer's `SCAN_OVERLAY_MODEL_INDEX`: far above any index the model allocator hands out. */
const OVERLAY_MODEL_INDEX = 0x7fff_ff00;

describe('ordinary content keeps main\'s batching with spatial chunking off (#6894)', () => {
  const COLOURS: [number, number, number, number][] = [[0.5, 0.5, 0.5, 1], [0.8, 0.2, 0.2, 1], [0.2, 0.6, 0.3, 1], [0.3, 0.3, 0.8, 1]];
  let seed = 6894;
  const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  const box = (id: number, x: number, color: [number, number, number, number], length = 2): MeshData => ({
    expressId: id,
    positions: new Float32Array([x, 0, 0, x + length, 0, 0, x + length, 1, 0, x, 1, 0]),
    normals: new Float32Array(12).fill(0.5),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    color,
  });
  const N = 2000, L = 40_000;
  const spatial = Array.from({ length: N }, (_, i) => box(i + 1, (i / N) * L, COLOURS[i % 4]));
  const cases: Array<[string, MeshData[], number]> = [
    ['a 40 km road in spatial order', spatial, 4],
    ['the same road in random order', [...spatial].sort(() => rand() - 0.5), 4],
    ['each colour alternating between both ends', Array.from({ length: N }, (_, i) => box(i + 1, (i >> 2) % 2 ? L - (i / N) * 50 : (i / N) * 50, COLOURS[i % 4])), 4],
    ['20 meshes 40 km long among 500 small ones', [...Array.from({ length: 20 }, (_, i) => box(i + 1, 0, COLOURS[0], L)),
      ...Array.from({ length: 500 }, (_, i) => box(100 + i, rand() * L, COLOURS[0]))].sort(() => rand() - 0.5), 1],
  ];
  for (const [name, meshes, batches] of cases) {
    it(`${name}: ${batches} batch(es), as on main`, () => {
      const scene = new Scene();
      const { device } = fakeDevice();
      scene.appendToBatches(meshes, device, pipeline, false);
      assert.equal(scene.getBatchedMeshes().length, batches);
    });
  }
});

describe('the scan overlay, as its own model index, keeps float32 precision whatever model 0 drew first (#6894)', () => {
  const anchors = { LV95: [2_600_000.37, 410.21, -1_200_000.83], UTM: [500_000.37, 300.21, -5_300_000.83] } as const;
  for (const [name, origin] of Object.entries(anchors)) {
    for (const colour of ['own colour', 'same colour'] as const) {
      for (const order of ['near geometry first', 'overlay first'] as const) {
        it(`${name}, ${colour}, ${order}`, () => {
          const scene = new Scene();
          const { device, bytes } = fakeDevice();
          const near = nearMesh(1);
          const overlay = { ...overlayMesh(2, [...origin], colour === 'same colour' ? [0.5, 0.5, 0.5, 1] : [0.2, 0.45, 0.95, 0.35]), modelIndex: OVERLAY_MODEL_INDEX };
          for (const mesh of order === 'near geometry first' ? [near, overlay] : [overlay, near]) {
            scene.appendToBatches([mesh], device, pipeline, false);
          }
          const overlayError = worstError(scene, bytes, overlay);
          const nearError = worstError(scene, bytes, near);
          assert.ok(overlayError < 1e-3, `overlay vertex off by ${overlayError} m`);
          assert.ok(nearError < 1e-3, `near vertex off by ${nearError} m`);
        });
      }
    }
  }
});

describe('a model left with no batches forgets its shared frame (#6894)', () => {
  // A second detection on a scan tens of km from the first: the viewer clears the
  // overlay's batches, then draws the new run. Its frame must come from the new
  // run, not the first run's origin (95 mm LV95 to LV95 +30 km, ~0.25 m LV95 to UTM).
  const runs: Array<[string, [number, number, number], [number, number, number]]> = [
    ['LV95 to UTM', [2_600_000.37, 410.21, -1_200_000.83], [500_000.37, 300.21, -5_300_000.83]],
    ['LV95 to LV95 +30 km', [2_600_000.37, 410.21, -1_200_000.83], [2_630_000.37, 410.21, -1_230_000.83]],
  ];
  for (const [name, first, second] of runs) {
    it(`${name}: the second run is drawn within 1 mm`, () => {
      const scene = new Scene();
      const { device, bytes } = fakeDevice();
      scene.appendToBatches([nearMesh(1)], device, pipeline, false);
      const color: [number, number, number, number] = [0.2, 0.45, 0.95, 0.35];
      scene.appendToBatches([{ ...overlayMesh(2, first, color), modelIndex: OVERLAY_MODEL_INDEX }], device, pipeline, false);
      // The overlay channel cleared, as `useAuthoringOverlay` clears it: remove, then rebuild.
      scene.removeMeshesForEntities([2]);
      scene.rebuildPendingBatches(device, pipeline);
      const next = { ...overlayMesh(3, second, color), modelIndex: OVERLAY_MODEL_INDEX };
      scene.appendToBatches([next], device, pipeline, false);
      const error = worstError(scene, bytes, next);
      assert.ok(error < 1e-3, `second run vertex off by ${error} m`);
      assert.ok(worstError(scene, bytes, nearMesh(1)) < 1e-3, 'model 0 is untouched');
    });
  }

  it('model 0 keeps its shared frame when emptied, as on main', () => {
    const scene = new Scene();
    const { device } = fakeDevice();
    scene.appendToBatches([nearMesh(1)], device, pipeline, false);
    const first = scene.getBatchedMeshes()[0].origin;
    scene.removeMeshesForEntities([1]);
    scene.rebuildPendingBatches(device, pipeline);
    const moved = { ...nearMesh(4), positions: nearMesh(4).positions.map((v, i) => (i % 3 === 0 ? v + 5 : v)) };
    scene.appendToBatches([moved], device, pipeline, false);
    assert.deepEqual(scene.getBatchedMeshes()[0].origin, first);
  });
});
