/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hide / isolate while streaming, when one entity's geometry is spread over
 * several streaming fragments of the same bucket (#9081).
 *
 * Invariant: a frame draws every visible entity's geometry exactly once and no
 * hidden entity's, and a partial batch keeps its source batch's quantization
 * (#4832). The oracle is the index count of the meshes handed to the scene,
 * never a count read back from it; triangle counts within a case are distinct
 * powers of two, so each set of drawn meshes has its own total.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import { BATCH_CONSTANTS } from './constants.js';
import { PartialBatchRequests } from './partial-batch-requests.js';
import { XRayAlpha } from './xray-alpha.js';
import { shouldRouteBatchTransparent, type RGBAOverrideMap } from './overlay-routing.js';
import type { BatchedMesh, RenderOptions } from './types.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

const device = {
  limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
  createBuffer: (desc: GPUBufferDescriptor) => ({ size: desc.size, destroy() {} }),
  createBindGroup: () => ({}),
  queue: { writeBuffer: () => {} },
} as unknown as GPUDevice;

const pipeline = {
  getUniformBufferSize: () => 256,
  getBindGroupLayout: () => ({}),
} as unknown as Parameters<Scene['appendToBatches']>[2];

const GREY: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
const GLASS: [number, number, number, number] = [0.6, 0.8, 0.9, 0.4];

/** `triangles` triangles over three shared vertices at `x`, `size` wide. */
function mesh(expressId: number, x: number, { triangles = 1, size = 1, modelIndex = 0, color = GREY } = {}): MeshData {
  return {
    expressId,
    modelIndex,
    positions: new Float32Array([x, 0, 0, x + size, 0, 0, x, size, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array(triangles * 3).map((_, i) => i % 3),
    color,
  };
}

function stream(scene: Scene, meshes: MeshData[]): void {
  scene.appendToBatches(meshes, device, pipeline, true);
}

/**
 * Indices one frame draws: a batch whose ids are all visible is drawn whole,
 * a partly visible one through the partial batches the render loop requests
 * (real slot keys and partition gate).
 */
function drawnIndices(scene: Scene, visible: ReadonlySet<number>, overrides: RGBAOverrideMap | null = null): number {
  const requests = new PartialBatchRequests(overrides, new XRayAlpha({}, new Set()), (batch) => scene.canPartitionBatch(batch));
  let drawn = 0;
  for (const batch of scene.getBatchedMeshes()) {
    const ids = new Set(batch.expressIds.filter((id) => visible.has(id)));
    if (ids.size === new Set(batch.expressIds).size) drawn += batch.indexCount;
    else if (ids.size > 0) requests.pushVisible(batch, ids, batch.color[3] < 1);
  }
  for (const { sourceBatch, sourceBatchKey, colorKey, visibleIds } of requests.items) {
    const partial = scene.getOrCreatePartialBatch(sourceBatchKey, colorKey, visibleIds, device, pipeline);
    if (!partial) continue;
    assert.strictEqual(Boolean(partial.quantized), Boolean(sourceBatch.quantized), `${sourceBatchKey} keeps its source's quantization`);
    drawn += partial.indexCount;
  }
  return drawn;
}

/** Index count of the given meshes whose entity is visible. */
function expectedIndices(meshes: MeshData[], visible: ReadonlySet<number>): number {
  return meshes.filter((m) => visible.has(m.expressId)).reduce((sum, m) => sum + m.indices.length, 0);
}

/** For each visibility set, the frame draws exactly the visible meshes, once. */
function assertDrawnOnce(scene: Scene, meshes: MeshData[], cases: Record<string, number[]>, overrides: RGBAOverrideMap | null = null): void {
  for (const [label, ids] of Object.entries(cases)) {
    const visible = new Set(ids);
    assert.strictEqual(drawnIndices(scene, visible, overrides), expectedIndices(meshes, visible), label);
  }
}

/** A case only tests #9081 when `expressId` is spread over two or more fragments. */
function assertSpread(scene: Scene, expressId: number): void {
  assert.strictEqual(scene.hasStreamingFragments(), true, 'still streaming: the fragment path is live');
  const holding = scene.getBatchedMeshes().filter((batch) => batch.expressIds.includes(expressId));
  assert.ok(holding.length >= 2, `entity ${expressId} is spread over ${holding.length} fragments`);
}

describe('Scene partial batches of streaming fragments draw an entity once (#9081)', () => {
  it('entity whose meshes arrive in two appends', () => {
    const scene = new Scene();
    const A = 1, B = 2, C = 3;
    const meshes = [mesh(A, 0), mesh(B, 2, { triangles: 2 }), mesh(A, 4, { triangles: 4 }), mesh(C, 6, { triangles: 8 })];
    stream(scene, meshes.slice(0, 2));
    stream(scene, meshes.slice(2));
    assertSpread(scene, A);
    assertDrawnOnce(scene, meshes, { 'isolate A': [A], 'hide B': [A, C], 'hide C': [A, B], 'hide A': [B, C] });
  });

  it('mesh split by splitMeshForStreaming, queued: its pieces arrive in separate appends', () => {
    const scene = new Scene();
    const P = 1, B = 2;
    // 180_000 indices fill one append; the rest of P is its own piece and lands in the next.
    const meshes = [mesh(P, 0, { triangles: 60_001 }), mesh(B, 2, { triangles: 2 })];
    scene.queueMeshes(meshes);
    scene.flushPending(device, pipeline, Number.POSITIVE_INFINITY);
    assert.strictEqual(scene.hasQueuedMeshes(), false);
    assertSpread(scene, P);
    assertDrawnOnce(scene, meshes, { 'isolate P': [P], 'hide P': [B], 'isolate B': [B] });
  });

  it('mesh split by splitMeshForStreaming, appended whole: its pieces straddle two buffer chunks', () => {
    const scene = new Scene();
    const P = 1, B = 2;
    // One piece's 180_000 indices fill a GPU buffer, so P's second piece opens the next fragment.
    scene['cachedMaxBufferSize'] = 180_000 * BATCH_CONSTANTS.BYTES_PER_INDEX;
    const meshes = [mesh(P, 0, { triangles: 60_001 }), mesh(B, 2, { triangles: 2 })];
    stream(scene, meshes);
    assertSpread(scene, P);
    assertDrawnOnce(scene, meshes, { 'isolate P': [P], 'hide P': [B], 'isolate B': [B] });

    // A model translation re-places P; the pieces cut from it must follow.
    scene.setModelTranslation(0, [100, 0, 0]);
    const shared = scene.getBatchedMeshes().find((batch) => batch.expressIds.includes(P) && batch.expressIds.includes(B));
    assert.ok(shared, 'one fragment holds a piece of P and B');
    const partial = scene.getOrCreatePartialBatch(`${shared.colorKey}:${shared.id}`, shared.colorKey, new Set([P]), device, pipeline);
    assert.deepStrictEqual(partial?.bounds, { min: [100, 0, 0], max: [101, 1, 0] }, 'isolate P after translation');
  });

  it('index-less mesh over the streaming vertex-byte limit', () => {
    const scene = new Scene();
    const empty = 1, B = 2;
    // 8 MiB of positions + normals with no indices: splitting it yields no piece,
    // and its own colour would leave its fragment group empty.
    const vertices = (4 * 1024 * 1024) / 12 + 1;
    const meshes = [
      { ...mesh(empty, 0, { color: GLASS }), positions: new Float32Array(vertices * 3), normals: new Float32Array(vertices * 3), indices: new Uint32Array(0) },
      mesh(B, 2),
    ];
    stream(scene, meshes);
    assertDrawnOnce(scene, meshes, { 'isolate B': [B] });
  });

  it('translucent entity split across two appends', () => {
    const scene = new Scene();
    const T = 1, U = 2, V = 3, W = 4;
    const glass = (id: number, x: number, triangles: number) => mesh(id, x, { triangles, color: GLASS });
    const meshes = [glass(T, 0, 1), glass(U, 2, 2), glass(T, 4, 4), glass(V, 6, 8), glass(W, 8, 16)];
    stream(scene, meshes.slice(0, 2));
    stream(scene, meshes.slice(2));
    assertSpread(scene, T);
    assertDrawnOnce(scene, meshes, { 'isolate T': [T], 'hide U': [T, V, W], 'hide U and V': [T, W] });
    // A lens colour on W splits the fragment holding it by promotion (#9254), still drawing each mesh once.
    const lens: RGBAOverrideMap = new Map([[W, [1, 0, 0, 1]]]);
    assertDrawnOnce(scene, meshes, { 'hide U and V, W promoted': [T, W] }, lens);
  });

  for (const modelIndex of [0, 1]) {
    it(`async finalize window on an overflow chain, model ${modelIndex}`, async () => {
      const scene = new Scene();
      scene.setQuantizedBatches(true);
      // Room for two meshes per bucket: the second append overflows into `<base>#0`.
      scene['cachedMaxBufferSize'] = 2 * 3 * BATCH_CONSTANTS.BYTES_PER_VERTEX;
      const ids = [1, 2, 3, 4].map((n) => modelIndex * 1_000_000 + n);
      // The first mesh is too large to quantize, so batches holding it are f32.
      const meshes = ids.map((id, i) => mesh(id, 2 * i, { modelIndex, triangles: 2 ** i, size: i === 0 ? 5000 : 1 }));
      stream(scene, meshes.slice(0, 2));
      stream(scene, meshes.slice(2));

      // A zero budget yields after the first rebuilt bucket. Until the swap the
      // fragments are still drawn, while the regroup has already re-routed
      // their meshes, re-creating `<base>#0` with other pieces.
      const finalized = scene.finalizeStreamingAsync(device, pipeline, 0);
      assert.strictEqual(scene.isFinalizeInProgress(), true, 'inside the finalize window');
      const isolateEach = Object.fromEntries(ids.map((id) => [`isolate ${id}`, [id]]));
      assertDrawnOnce(scene, meshes, isolateEach);
      await finalized;
      assertDrawnOnce(scene, meshes, isolateEach);
    });
  }
});

/**
 * One frame as the render loop classifies it (index.ts): a partly visible
 * batch through `pushAlphaSplit`, else `pushVisible`; a fully visible one
 * through `pushWholeSplit`, else drawn whole. Indices are tallied by the route
 * each drawn (sub-)batch takes: pipeline and resolved X-Ray alpha.
 */
function routedIndices(scene: Scene, visible: ReadonlySet<number> | null, overrides: RGBAOverrideMap | null, xray: XRayAlpha): Map<string, number> {
  const routes = new Map<string, number>();
  const draw = (batch: BatchedMesh) => {
    const alpha = xray.forBatch(batch, batch.color[3]);
    const route = `${shouldRouteBatchTransparent(alpha, batch.expressIds, overrides) ? 'transparent' : 'opaque'}@${alpha}`;
    routes.set(route, (routes.get(route) ?? 0) + batch.indexCount);
  };
  const requests = new PartialBatchRequests(overrides, xray, (batch) => scene.canPartitionBatch(batch));
  for (const batch of scene.getBatchedMeshes()) {
    const transparent = xray.forBatch(batch, batch.color[3]) < 0.99;
    const ids = new Set(batch.expressIds.filter((id) => visible?.has(id) ?? true));
    if (ids.size === 0) continue;
    if (ids.size < new Set(batch.expressIds).size) {
      if (!requests.pushAlphaSplit(batch, ids)) requests.pushVisible(batch, ids, transparent);
    } else if (!requests.pushWholeSplit(batch, transparent)) draw(batch);
  }
  for (const { sourceBatchKey, colorKey, visibleIds } of requests.items) {
    const partial = scene.getOrCreatePartialBatch(sourceBatchKey, colorKey, visibleIds, device, pipeline);
    if (partial) draw(partial);
  }
  return routes;
}

/** The routes `routedIndices` must report: each visible mesh once, on its own entity's route. */
function expectedRoutes(meshes: MeshData[], visible: ReadonlySet<number> | null, overrides: RGBAOverrideMap | null, xray: XRayAlpha): Map<string, number> {
  const routes = new Map<string, number>();
  for (const m of meshes) {
    if (visible && !visible.has(m.expressId)) continue;
    const alpha = xray.forEntity(m.expressId, m.color[3]);
    const route = `${shouldRouteBatchTransparent(alpha, [m.expressId], overrides) ? 'transparent' : 'opaque'}@${alpha}`;
    routes.set(route, (routes.get(route) ?? 0) + m.indices.length);
  }
  return routes;
}

function assertRoutes(scene: Scene, meshes: MeshData[], cases: Record<string, number[] | null>, overrides: RGBAOverrideMap | null, xrayOptions: RenderOptions = {}): void {
  const xray = new XRayAlpha(xrayOptions, new Set());
  for (const [label, ids] of Object.entries(cases)) {
    const visible = ids && new Set(ids);
    const sorted = (routes: Map<string, number>) => [...routes].sort(([a], [b]) => a.localeCompare(b));
    assert.deepStrictEqual(sorted(routedIndices(scene, visible, overrides, xray)), sorted(expectedRoutes(meshes, visible, overrides, xray)), label);
  }
}

describe('a streaming fragment splits per entity like a finalized batch (#9254)', () => {
  const glass = (id: number, x: number, triangles: number) => mesh(id, x, { triangles, color: GLASS });
  const RED: [number, number, number, number] = [1, 0, 0, 1];

  it('a transparent fragment with mixed overrides shows its override colour while streaming, each mesh drawn once', () => {
    const scene = new Scene();
    const T = 1, U = 2, V = 3, W = 4;
    const meshes = [glass(T, 0, 1), glass(U, 2, 2), glass(T, 4, 4), glass(V, 6, 8), glass(W, 8, 16)];
    stream(scene, meshes.slice(0, 2));
    stream(scene, meshes.slice(2));
    assertSpread(scene, T);
    const lens: RGBAOverrideMap = new Map([[T, RED], [W, RED]]);
    assertRoutes(scene, meshes, { 'all visible': null, 'hide U': [T, V, W], 'hide W': [T, U, V], 'isolate T': [T] }, lens);
  });

  it('a mesh split across two fragments by the buffer limit: each fragment promotes only its own pieces', () => {
    const scene = new Scene();
    const P = 1, B = 2;
    // One piece's 180_000 indices fill a GPU buffer, so P's second piece opens the next fragment, beside B.
    scene['cachedMaxBufferSize'] = 180_000 * BATCH_CONSTANTS.BYTES_PER_INDEX;
    const meshes = [glass(P, 0, 60_001), glass(B, 2, 2)];
    stream(scene, meshes);
    assertSpread(scene, P);
    assertRoutes(scene, meshes, { 'all visible': null, 'isolate P': [P] }, new Map([[P, RED]]));
  });

  it('X-Ray fades only the overridden entity of a fragment, not its batchmates', () => {
    const scene = new Scene();
    const A = 1, B = 2, C = 3;
    const meshes = [mesh(A, 0), mesh(B, 2, { triangles: 2 }), mesh(A, 4, { triangles: 4 }), mesh(C, 6, { triangles: 8 })];
    stream(scene, meshes.slice(0, 2));
    stream(scene, meshes.slice(2));
    assertSpread(scene, A);
    assertRoutes(scene, meshes, { 'all visible': null, 'hide C': [A, B] }, null, { transparencyOverrides: new Map([[B, 0.2]]) });
  });

  it('a fragment holding a colour-merged mesh is not partitioned: drawn whole, once', () => {
    const scene = new Scene();
    // One mesh carrying entities 7 and 8 per vertex, registered under both ids.
    const merged: MeshData = {
      ...glass(7, 0, 1),
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0]),
      normals: new Float32Array(18).map((_, i) => (i % 3 === 2 ? 1 : 0)),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
      entityIds: new Uint32Array([7, 7, 7, 8, 8, 8]),
    };
    stream(scene, [merged]);
    const [fragment] = scene.getBatchedMeshes();
    assert.strictEqual(scene.canPartitionBatch(fragment), false);
    const routes = routedIndices(scene, null, new Map([[7, RED]]), new XRayAlpha({}, new Set()));
    assert.deepStrictEqual([...routes.values()], [6], 'one whole draw of the merged mesh, not one per subset');
  });

  it('an ephemeral stream keeps no piece list, so its fragments are drawn whole, once', () => {
    const scene = new Scene();
    scene.setEphemeralStreamingMode(true);
    const meshes = [glass(1, 0, 1), glass(2, 2, 2)];
    stream(scene, meshes);
    for (const fragment of scene.getBatchedMeshes()) assert.strictEqual(scene.canPartitionBatch(fragment), false);
    const routes = routedIndices(scene, null, new Map([[1, RED]]), new XRayAlpha({}, new Set()));
    assert.deepStrictEqual([...routes.values()], [9], 'one whole draw of the fragment, not one per subset');
  });

  it('a time-sliced finalize under tight budgets leaves the old fragments their pieces until the swap', async () => {
    const scene = new Scene();
    const T = 1, U = 2, V = 3, W = 4;
    const TINT: [number, number, number, number] = [0.9, 0.6, 0.3, 0.4];
    const meshes = [glass(T, 0, 1), glass(U, 2, 2), mesh(V, 4, { triangles: 4, color: TINT }), glass(T, 6, 8), mesh(W, 8, { triangles: 16, color: TINT })];
    scene.setColdGeometryProvider({ loadMeshesInBounds: async () => [] });
    scene.setGpuResidencyBudget(1);
    scene.setHostResidencyBudget(1);
    stream(scene, meshes.slice(0, 3));
    stream(scene, meshes.slice(3));
    assertSpread(scene, T);

    // A zero time budget yields after the first rebuilt bucket. Its batch is
    // built but not yet published, so it has never been drawn: to the budget
    // passes it looks old enough to evict, then to demote cold, which would
    // take its meshes out of meshDataMap while the old fragments still cut
    // their subsets from them.
    const finalized = scene.finalizeStreamingAsync(device, pipeline, 0);
    assert.strictEqual(scene.isFinalizeInProgress(), true, 'inside the finalize window');
    for (let i = 0; i < 200; i++) {
      scene.beginResidencyFrame();
      scene.enforceGpuBudget();
    }
    const lens: RGBAOverrideMap = new Map([[T, RED], [V, RED]]);
    assertRoutes(scene, meshes, { 'all visible, T and V promoted': null }, lens);
    await finalized;
    assert.strictEqual(scene.isFinalizeInProgress(), false);
    assert.ok(scene.getBatchedMeshes().every((batch) => batch.gpuResident !== false), 'no batch was evicted before it was published');
  });
});

/**
 * A finalized batch keeps drawing while streaming continues into its bucket:
 * after a sync finalize mid-stream (a placement edit) or across the async
 * finalize window. Its partial batch must draw only the pieces it holds, not
 * the bucket's newer pieces a streaming fragment already draws (#9270).
 */
describe('a finalized batch partial draws only the pieces it holds (#9270)', () => {
  const RED: [number, number, number, number] = [1, 0, 0, 1];

  it('stream, sync finalize, stream on: isolating an entity spread over the batch and a fragment draws it once', () => {
    const scene = new Scene();
    const A = 1, B = 2, C = 3;
    const meshes = [mesh(A, 0), mesh(B, 2, { triangles: 2 }), mesh(A, 4, { triangles: 4 }), mesh(C, 6, { triangles: 8 })];
    stream(scene, meshes.slice(0, 2));
    scene.finalizeStreaming(device, pipeline);
    stream(scene, meshes.slice(2));
    assertSpread(scene, A);
    assert.strictEqual(drawnIndices(scene, new Set([A])), 15, 'isolate A: A1 + A2, once each');
    assertDrawnOnce(scene, meshes, { 'isolate A': [A], 'hide B': [A, C], 'hide C': [A, B], 'hide A': [B, C] });
    // X-Ray on B splits the finalized batch per entity: its A subset must not take the fragment's A2.
    assertRoutes(scene, meshes, { 'all visible, B faded': null, 'hide C, B faded': [A, B] }, null, { transparencyOverrides: new Map([[B, 0.2]]) });
  });

  it('a translucent finalized batch split by a lens promotes only its own pieces', () => {
    const scene = new Scene();
    const T = 1, U = 2, V = 3;
    const glass = (id: number, x: number, triangles: number) => mesh(id, x, { triangles, color: GLASS });
    const meshes = [glass(T, 0, 1), glass(U, 2, 2), glass(T, 4, 4), glass(V, 6, 8)];
    stream(scene, meshes.slice(0, 2));
    scene.finalizeStreaming(device, pipeline);
    stream(scene, meshes.slice(2));
    assertSpread(scene, T);
    assertRoutes(scene, meshes, { 'all visible, T promoted': null, 'hide V, T promoted': [T, U] }, new Map([[T, RED]]));
  });

  it('appends during the async finalize window: each piece drawn once, before and after the swap', async () => {
    const scene = new Scene();
    const A = 1, B = 2, C = 3, D = 4;
    const meshes = [
      mesh(A, 0), mesh(B, 2, { triangles: 2 }), mesh(A, 4, { triangles: 4 }), mesh(C, 6, { triangles: 8 }),
      mesh(A, 8, { triangles: 16 }), mesh(D, 10, { triangles: 32 }),
    ];
    stream(scene, meshes.slice(0, 2));
    scene.finalizeStreaming(device, pipeline);
    stream(scene, meshes.slice(2, 4));
    // A zero budget yields after the bucket's replacement batch is built; the
    // old finalized batch and both fragments draw until the swap.
    const finalized = scene.finalizeStreamingAsync(device, pipeline, 0);
    assert.strictEqual(scene.isFinalizeInProgress(), true, 'inside the finalize window');
    stream(scene, meshes.slice(4));
    const cases = { 'isolate A': [A], 'hide B': [A, C, D], 'hide D': [A, B, C], 'isolate D': [D] };
    assert.strictEqual(drawnIndices(scene, new Set([A])), 63, 'isolate A in the window: A1 + A2 + A3, once each');
    assertDrawnOnce(scene, meshes, cases);
    // The old batch is no longer its bucket's live batch, but it knows its pieces: X-Ray splits it per entity.
    assertRoutes(scene, meshes, { 'all visible, B faded': null }, null, { transparencyOverrides: new Map([[B, 0.2]]) });
    await finalized;
    assert.strictEqual(scene.hasStreamingFragments(), true, 'the window append is still a fragment after the swap');
    assert.strictEqual(drawnIndices(scene, new Set([A])), 63, 'isolate A after the swap: A1 + A2 + A3, once each');
    assertDrawnOnce(scene, meshes, cases);
  });

  it('a piece the finalize regroup re-homes is still drawn by the batch holding it until the swap', async () => {
    const scene = new Scene();
    const A = 1, B = 2, C = 3;
    const meshes = [mesh(A, 0), mesh(B, 2, { triangles: 2 }), mesh(A, 4, { triangles: 4 }), mesh(C, 6, { triangles: 8 })];
    stream(scene, meshes.slice(0, 2));
    scene.finalizeStreaming(device, pipeline);
    stream(scene, meshes.slice(2));
    // A deferred style colour lands in place on the registered A1: the regroup routes it
    // to another bucket, while the old finalized batch, which holds A1, draws until the swap.
    const registeredA1 = scene['meshDataMap'].get(A)?.[0];
    assert.ok(registeredA1 && registeredA1.indices.length === 3, 'A1 is registered first');
    registeredA1.color = RED;
    const finalized = scene.finalizeStreamingAsync(device, pipeline, 0);
    assert.strictEqual(scene.isFinalizeInProgress(), true, 'inside the finalize window');
    const cases = { 'isolate A': [A], 'hide B': [A, C], 'hide A': [B, C] };
    assertDrawnOnce(scene, meshes, cases);
    await finalized;
    assertDrawnOnce(scene, meshes, cases);
  });

  it('a piece the finalize regroup moves into an existing bucket stays out of that bucket\'s old batch until the swap', async () => {
    const scene = new Scene();
    const A = 1, B = 2, C = 3, R = 4;
    // A0 is red from the start, so the red bucket's finalized batch holds a piece of A, beside R.
    const meshes = [mesh(A, 0), mesh(B, 2, { triangles: 2 }), mesh(A, 4, { triangles: 4, color: RED }), mesh(R, 6, { triangles: 32, color: RED }),
      mesh(A, 8, { triangles: 8 }), mesh(C, 10, { triangles: 16 })];
    stream(scene, meshes.slice(0, 4));
    scene.finalizeStreaming(device, pipeline);
    stream(scene, meshes.slice(4));
    // The streamed A2 turns red in place: the regroup moves it into the red bucket, whose
    // finalized batch did not hold it and draws until the swap, beside A2's fragment.
    const registeredA2 = scene['meshDataMap'].get(A)?.find((piece) => piece.indices.length === 24);
    assert.ok(registeredA2, 'A2 is registered');
    registeredA2.color = RED;
    const finalized = scene.finalizeStreamingAsync(device, pipeline, 0);
    assert.strictEqual(scene.isFinalizeInProgress(), true, 'inside the finalize window');
    const cases = { 'isolate A': [A], 'hide R': [A, B, C], 'hide A': [B, C, R] };
    assertDrawnOnce(scene, meshes, cases);
    await finalized;
    assertDrawnOnce(scene, meshes, cases);
  });
});
