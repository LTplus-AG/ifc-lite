/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A finished scene out of one Scene and into another: driven through the real
 * queue, finalize, adoption and hydration, on a stub device that records what
 * reaches the GPU.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';
import { decodeSceneSnapshot, encodeSceneSnapshot, type SceneSnapshot } from './scene-snapshot.js';
import { reorderSnapshotPieces } from './scene-snapshot-batches.js';
import { PartialBatchRequests } from './partial-batch-requests.js';
import { XRayAlpha } from './xray-alpha.js';

(globalThis as unknown as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = { VERTEX: 32, INDEX: 16, UNIFORM: 64, COPY_DST: 8, COPY_SRC: 4, STORAGE: 128 };

const RED: [number, number, number, number] = [1, 0, 0, 1];
const BLUE: [number, number, number, number] = [0, 0, 1, 1];

function triangle(expressId: number, x: number, color = RED): MeshData {
  return {
    expressId, modelIndex: 0, color,
    positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  } as MeshData;
}

const model = () => [triangle(1, 0), triangle(2, 2, BLUE), triangle(3, 4)];

let written: { bytes: number[]; usage: number; buffer: object }[];
let destroyed: number;
let failCreateAfter: number;

function stubDevice(): GPUDevice {
  return {
    limits: { maxBufferSize: 1 << 28 },
    createBuffer: ({ usage }: { usage: number }) => {
      if (failCreateAfter-- === 0) throw new Error('out of memory');
      return { usage, destroy() { destroyed++; } };
    },
    createBindGroup: () => ({}),
    queue: {
      writeBuffer: (buffer: { usage: number }, _offset: number, data: ArrayBuffer | ArrayBufferView, dataOffset = 0, size?: number) => {
        const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        written.push({ bytes: [...view.subarray(dataOffset, size === undefined ? undefined : dataOffset + size)], usage: buffer.usage, buffer });
      },
    },
  } as unknown as GPUDevice;
}

const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as RenderPipeline;

let lastFinalized: Scene;

/** Each batch's uploaded vertex and index bytes, by bucket key. */
function uploadedByBatch(scene: Scene): Record<string, string[]> {
  const bytes = (buffer: GPUBuffer) => written.find((w) => w.buffer === buffer)?.bytes.join();
  return Object.fromEntries(scene.getBatchedMeshes().map((b) => [b.colorKey, [bytes(b.vertexBuffer)!, bytes(b.indexBuffer)!]]));
}

let lastSources: readonly MeshData[] = [];

async function captureScene(meshes: MeshData[], device: GPUDevice): Promise<SceneSnapshot | null> {
  const scene = lastFinalized = new Scene();
  scene.setQuantizedBatches(true);
  let captured: SceneSnapshot | null = null;
  scene.captureNextFinalize((snapshot, sources) => { captured = snapshot; lastSources = sources; });
  scene.clearFlatGeometry(); // the load's own reshape, before its first piece
  scene.queueMeshes(meshes);
  scene.flushPending(device, pipeline, 1000);
  written = []; // from here on, only what finalize itself uploads
  await scene.finalizeStreamingAsync(device, pipeline);
  return captured;
}

function freshScene(): Scene {
  const scene = new Scene();
  scene.setQuantizedBatches(true);
  return scene;
}

const roundTrip = async (snapshot: SceneSnapshot) => decodeSceneSnapshot(await encodeSceneSnapshot(snapshot).arrayBuffer())!;

describe('finished-scene snapshot', () => {
  beforeEach(() => { written = []; destroyed = 0; failCreateAfter = -1; });

  it('uploads exactly the bytes finalize uploaded, once, with no merge', async () => {
    const device = stubDevice();
    const snapshot = await captureScene(model(), device);
    assert.ok(snapshot);
    assert.strictEqual(snapshot.pieceCount, 3);
    const finalized = uploadedByBatch(lastFinalized);
    assert.deepStrictEqual(Object.keys(finalized).length, snapshot.batches.length);

    written = [];
    const scene = freshScene();
    assert.ok(scene.adoptSceneSnapshot(await roundTrip(snapshot), device, pipeline));
    assert.strictEqual(written.filter((w) => w.usage & (32 | 16)).length, snapshot.batches.length * 2, 'each buffer once');
    assert.deepStrictEqual(uploadedByBatch(scene), finalized, 'each batch draws the bytes finalize gave it');
    assert.deepStrictEqual(scene.getBatchedMeshes().map((b) => b.colorKey).sort(), snapshot.batches.map((b) => b.key).sort());
  });

  // W2: a cold load queues meshes in arrival order; its cache entry stores them in
  // spatial chunks, and a reopen hydrates in that order.
  it('hydrates a reopen that decodes the meshes in another order once the ordinals are moved to it', async () => {
    const device = stubDevice();
    const queued = model();
    const snapshot = (await captureScene(queued, device))!;
    assert.deepStrictEqual(lastSources, queued, 'one source per piece, in queue order');
    const decodedOrder = [2, 0, 1];
    const reopen = () => decodedOrder.map((i) => ({ ...model()[i] }));

    const stale = freshScene();
    assert.strictEqual(stale.hydrateSceneSnapshot(stale.adoptSceneSnapshot(await roundTrip(snapshot), device, pipeline)!, reopen()), false,
      'queue-order ordinals are refused for another decode order');

    const moved = reorderSnapshotPieces(snapshot, lastSources, decodedOrder.map((i) => queued[i]))!;
    assert.ok(moved);
    const scene = freshScene();
    written = [];
    assert.strictEqual(scene.hydrateSceneSnapshot(scene.adoptSceneSnapshot(await roundTrip(moved), device, pipeline)!, reopen()), true);
    assert.strictEqual(scene.getMeshDataPieces(2)?.length, 1);
    assert.strictEqual(reorderSnapshotPieces(snapshot, lastSources, [queued[0], queued[2]]), null, 'a queued mesh the entry lacks');
    assert.ok(reorderSnapshotPieces(snapshot, lastSources, [triangle(9, 9), ...queued]), 'a mesh that was never queued is skipped');
  });

  it('hydrates pieces into the batches they were merged into, without uploading', async () => {
    const device = stubDevice();
    const snapshot = await captureScene(model(), device);
    const scene = freshScene();
    const adoption = scene.adoptSceneSnapshot(await roundTrip(snapshot!), device, pipeline)!;
    assert.strictEqual(scene.isSceneSnapshotHydrating(), true);
    assert.strictEqual(scene.getMeshDataPieces(1), undefined, 'no pieces before hydration');

    written = [];
    assert.strictEqual(scene.hydrateSceneSnapshot(adoption, model()), true);
    assert.deepStrictEqual(written, []);
    assert.strictEqual(scene.isSceneSnapshotHydrating(), false);
    assert.strictEqual(scene.getMeshDataPieces(2)?.length, 1);
    for (const batch of scene.getBatchedMeshes()) {
      for (const id of batch.expressIds) assert.strictEqual(scene['meshDataBucket'].get(scene.getMeshDataPieces(id)![0])?.batchedMesh, batch);
    }
  });

  it('draws a partly hidden batch whole while hydrating instead of dropping it', async () => {
    const device = stubDevice();
    const snapshot = await captureScene(model(), device);
    const scene = freshScene();
    scene.adoptSceneSnapshot(await roundTrip(snapshot!), device, pipeline);
    const batch = scene.getBatchedMeshes().find((b) => b.expressIds.length === 2)!;
    assert.strictEqual(scene.getOrCreatePartialBatch(batch.colorKey, batch.colorKey, new Set([1]), device, pipeline), batch);
  });

  it('while hydrating, a transparent batch with mixed promotion draws whole, once (#9254)', async () => {
    const GLASS: [number, number, number, number] = [0.6, 0.8, 0.9, 0.4];
    const glassModel = () => [triangle(4, 0, GLASS), triangle(5, 2, GLASS), triangle(6, 4, GLASS)];
    const device = stubDevice();
    const snapshot = await captureScene(glassModel(), device);
    const scene = freshScene();
    scene.adoptSceneSnapshot(await roundTrip(snapshot!), device, pipeline);
    const glass = scene.getBatchedMeshes().find((b) => b.expressIds.includes(4))!;
    const lens = new Map([[4, [1, 0, 0, 1] as [number, number, number, number]], [7, [1, 0, 0, 1] as [number, number, number, number]]]);
    // Each slot the frame requests comes back as the whole batch while there are no pieces,
    // so a promotion split here would draw it through both :promoted and :remaining.
    const drawnIndices = (visible: Set<number> | null, batch = glass): number => {
      const requests = new PartialBatchRequests(lens, new XRayAlpha({}, new Set()), (b) => scene.canPartitionBatch(b));
      let drawn = 0;
      if (visible) requests.pushVisible(batch, visible, true);
      else if (!requests.pushWholeSplit(batch, true)) drawn += batch.indexCount;
      for (const r of requests.items) drawn += scene.getOrCreatePartialBatch(r.sourceBatchKey, r.colorKey, r.visibleIds, device, pipeline)?.indexCount ?? 0;
      return drawn;
    };
    assert.strictEqual(scene.isSceneSnapshotHydrating(), true);
    assert.strictEqual(drawnIndices(null), 9, 'fully visible: the whole batch, once');
    assert.strictEqual(drawnIndices(new Set([4, 5])), 9, 'under hide: the whole batch, once, until the pieces arrive');

    // A fragment streamed in meanwhile has its own pieces, but every slot is still served
    // the bucket's whole batch: splitting it would draw that batch once per subset.
    scene.appendToBatches([triangle(7, 6, GLASS), triangle(8, 8, GLASS)], device, pipeline, true);
    const fragment = scene.getBatchedMeshes().find((b) => b.expressIds.includes(7))!;
    assert.notStrictEqual(fragment, glass, 'a separate streaming fragment');
    assert.strictEqual(scene.canPartitionBatch(fragment), false);
    assert.strictEqual(drawnIndices(null, fragment), 6, 'the fragment, fully visible: drawn whole, once');
  });

  it('a later append joins the adopted buckets', async () => {
    const device = stubDevice();
    const snapshot = await captureScene(model(), device);
    const scene = freshScene();
    const adoption = scene.adoptSceneSnapshot(await roundTrip(snapshot!), device, pipeline)!;
    scene.hydrateSceneSnapshot(adoption, model());
    scene.appendToBatches([triangle(4, 6)], device, pipeline, false);
    const reds = scene.getBatchedMeshes().find((b) => b.expressIds.includes(4))!;
    assert.deepStrictEqual([...reds.expressIds].sort(), [1, 3, 4]);
    assert.strictEqual(scene.getMeshDataPieces(1)?.length, 1);
  });

  it('refuses meshes that are not the snapshot\'s, and clears what it adopted', async () => {
    const device = stubDevice();
    const snapshot = await captureScene(model(), device);
    for (const wrong of [[triangle(1, 0)], [triangle(9, 0), triangle(2, 2, BLUE), triangle(3, 4)]]) {
      const scene = freshScene();
      const adoption = scene.adoptSceneSnapshot(await roundTrip(snapshot!), device, pipeline)!;
      assert.strictEqual(scene.hydrateSceneSnapshot(adoption, wrong), false);
      assert.deepStrictEqual(scene.getBatchedMeshes(), []);
    }
  });

  it('a clear or a device loss ends the adoption; a newer adoption is not the old load\'s to abandon', async () => {
    const device = stubDevice();
    const snapshot = await captureScene(model(), device);
    const cleared = freshScene();
    const stale = cleared.adoptSceneSnapshot(await roundTrip(snapshot!), device, pipeline)!;
    cleared.clear();
    assert.strictEqual(cleared.hydrateSceneSnapshot(stale, model()), false);

    const newer = cleared.adoptSceneSnapshot(await roundTrip(snapshot!), device, pipeline)!;
    cleared.abandonSceneSnapshot(stale);
    assert.strictEqual(cleared.isSceneSnapshotHydrating(), true);
    assert.ok(cleared.getBatchedMeshes().length > 0);
    cleared.abandonSceneSnapshot(newer);
    assert.deepStrictEqual(cleared.getBatchedMeshes(), []);

    const lost = freshScene();
    const adoption = lost.adoptSceneSnapshot(await roundTrip(snapshot!), device, pipeline)!;
    lost.prepareDeviceRecovery();
    assert.strictEqual(lost.hydrateSceneSnapshot(adoption, model()), false);
  });

  it('a lost or abandoned adoption takes its shards with it; a mismatch keeps them', async () => {
    const device = stubDevice();
    const snapshot = await captureScene(model(), device);
    const removals = (scene: Scene) => {
      const removed: number[] = [];
      scene.removeInstancedTemplatesForModel = (index: number) => { removed.push(index); return 0; };
      return removed;
    };

    const abandoned = freshScene();
    const abandonedShards = removals(abandoned);
    abandoned.abandonSceneSnapshot(abandoned.adoptSceneSnapshot(await roundTrip(snapshot!), device, pipeline)!);
    assert.deepStrictEqual(abandonedShards, [0]);

    const takenOver = freshScene();
    const takenOverShards = removals(takenOver);
    takenOver.adoptSceneSnapshot(await roundTrip(snapshot!), device, pipeline);
    takenOver.clearFlatGeometry(); // a newer load's reshape
    assert.deepStrictEqual(takenOverShards, [0]);

    const mismatched = freshScene();
    const mismatchedShards = removals(mismatched);
    const adoption = mismatched.adoptSceneSnapshot(await roundTrip(snapshot!), device, pipeline)!;
    assert.strictEqual(mismatched.hydrateSceneSnapshot(adoption, [triangle(9, 0)]), false);
    assert.deepStrictEqual(mismatchedShards, []);
  });

  it('leaves the scene untouched when the policy differs or a buffer cannot be created', async () => {
    const device = stubDevice();
    const snapshot = await captureScene(model(), device);
    const offPolicy = new Scene();
    assert.strictEqual(offPolicy.adoptSceneSnapshot(await roundTrip(snapshot!), device, pipeline), null);

    const scene = freshScene();
    failCreateAfter = 3;
    assert.strictEqual(scene.adoptSceneSnapshot(await roundTrip(snapshot!), device, pipeline), null);
    assert.ok(destroyed > 0, 'staged buffers are freed');
    assert.deepStrictEqual(scene.getBatchedMeshes(), []);
    assert.strictEqual(scene.isSceneSnapshotHydrating(), false);
  });

  it('captures nothing from a scene that changed under it', async () => {
    const device = stubDevice();
    const scene = freshScene();
    let captured = false;
    scene.captureNextFinalize(() => { captured = true; });
    scene.queueMeshes(model());
    scene.clearFlatGeometry(); // past the first piece: another load's scene from here on
    scene.queueMeshes([triangle(9, 0)]);
    scene.flushPending(device, pipeline, 1000);
    await scene.finalizeStreamingAsync(device, pipeline);
    assert.strictEqual(captured, false);
  });
});
