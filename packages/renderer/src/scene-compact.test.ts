/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { adoptCompactMeshes, compactHydrationStats, loadCompactGeometry, materializeCompactMesh, type CompactPayload } from '@ifc-lite/geometry/compact';
import { createCompactPages, loadCompactPages } from './compact-page-deps.js';
import type { SceneCompactHost } from './scene-compact.js';
import { batchEntityIdAnchor } from './entity-color-table.js';
import { BatchVisibilityCache } from './batch-visibility.js';
import { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';
import { colorSaltByte, packEntityLane } from './scene-geometry.js';
import type { BatchedMesh } from './types.js';

Object.assign(globalThis, { GPUBufferUsage: { COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128 } });

type Rgba = [number, number, number, number];
const GREY: Rgba = [0.5, 0.5, 0.5, 1];
const RED: Rgba = [1, 0, 0, 1];

interface FakeBuffer { size: number; usage: number; data: Uint8Array; destroyed: boolean; destroy(): void }
const bytesOf = (buffer: GPUBuffer): Uint8Array => (buffer as unknown as FakeBuffer).data;
const isDestroyed = (buffer: GPUBuffer): boolean => (buffer as unknown as FakeBuffer).destroyed;

/** A device that keeps what is written to each buffer, so a test can read a page back. */
function fakeGpu(): { device: GPUDevice; pipeline: RenderPipeline } {
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer(descriptor: GPUBufferDescriptor): FakeBuffer {
      return { size: descriptor.size, usage: descriptor.usage, data: new Uint8Array(descriptor.size), destroyed: false, destroy() { this.destroyed = true; } };
    },
    createBindGroup() { return {}; },
    createCommandEncoder() {
      const copies: Array<() => void> = [];
      return {
        copyBufferToBuffer(src: FakeBuffer, srcOffset: number, dst: FakeBuffer, dstOffset: number, size: number) {
          copies.push(() => dst.data.set(src.data.subarray(srcOffset, srcOffset + size), dstOffset));
        },
        finish: () => copies,
      };
    },
    queue: {
      // A typed array's offset and size are in elements, as in WebGPU.
      writeBuffer(buffer: FakeBuffer, offset: number, data: ArrayBufferView | ArrayBuffer, dataOffset = 0, size?: number) {
        const view = ArrayBuffer.isView(data) ? data : new Uint8Array(data);
        const width = 'BYTES_PER_ELEMENT' in view ? (view as Uint8Array).BYTES_PER_ELEMENT : 1;
        const from = view.byteOffset + dataOffset * width;
        const length = size === undefined ? view.byteLength - dataOffset * width : size * width;
        buffer.data.set(new Uint8Array(view.buffer, from, length), offset);
      },
      submit(commands: Array<Array<() => void>>) { for (const copies of commands) for (const copy of copies) copy(); },
    },
  } as unknown as GPUDevice;
  const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as RenderPipeline;
  return { device, pipeline };
}

interface Box { expressId: number; at: [number, number, number]; size: number; color: Rgba }

/** A box's 12 triangles over corners 0-7 (bit `axis` of a corner: at the far side on that axis). */
const BOX_TRIANGLES = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
/** World coordinate of `corner` of `box` on `axis`. */
const boxCorner = (box: Box, corner: number, axis: number): number => box.at[axis] + ((corner >> axis) & 1) * box.size;

/**
 * A worker batch of welded boxes in the layout the wasm encoder writes: level 10, every box in the
 * window of cell 0 (16 m below the origin), lanes stamped with the id and colour salt.
 */
function compactBatch(boxes: readonly Box[], cellX = 0): MeshData[] {
  const scale = 1024, window = -16 * scale, windowX = (cellX * 32 - 16) * scale;
  const payload: CompactPayload = {
    records: new Uint8Array(boxes.length * 8 * 12), indices: new Uint16Array(boxes.length * 36),
    table: new Uint32Array(boxes.length * 7), windows: new Float64Array(boxes.length * 3).fill(window),
    bounds: new Float64Array(boxes.length * 6), cells: new Int32Array(boxes.length * 3),
  };
  // `cellX`: the compact cell on x ([32 * cellX - 16, 32 * cellX + 16) m), whose window the boxes are written in.
  for (let row = 0; row < boxes.length; row++) { payload.windows[row * 3] = windowX; payload.cells[row * 3] = cellX; }
  const view = new DataView(payload.records.buffer);
  boxes.forEach((box, row) => {
    payload.table.set([row, row * 8, 8, row * 36, 36, 10, 24], row * 7);
    payload.bounds.set([...box.at, box.at[0] + box.size, box.at[1] + box.size, box.at[2] + box.size], row * 6);
    payload.indices.set(BOX_TRIANGLES, row * 36);
    for (let corner = 0; corner < 8; corner++) {
      const at = (row * 8 + corner) * 12;
      for (let axis = 0; axis < 3; axis++) {
        view.setUint16(at + axis * 2, Math.round(boxCorner(box, corner, axis) * scale) - (axis === 0 ? windowX : window), true);
      }
      // Outward corner normal, oct-encoded: +-1/3 on each axis folds to bytes 85/170 (or their mirror for -z).
      const sign = [(corner & 1) * 2 - 1, ((corner >> 1) & 1) * 2 - 1, ((corner >> 2) & 1) * 2 - 1];
      const oct = (v: number) => Math.round((v * 0.5 + 0.5) * 255);
      const ox = sign[2] > 0 ? sign[0] / 3 : sign[0] * (2 / 3), oy = sign[2] > 0 ? sign[1] / 3 : sign[1] * (2 / 3);
      view.setUint16(at + 6, (oct(ox) << 8) | oct(oy), true);
      view.setUint32(at + 8, packEntityLane(box.expressId, colorSaltByte(box.color)), true);
    }
  });
  const meshes = boxes.map((box, row) => ({
    expressId: box.expressId, modelIndex: 0, color: box.color,
    positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0),
    compact: { batch: 0, row },
  })) as unknown as MeshData[];
  adoptCompactMeshes(meshes, [payload]);
  return meshes;
}

/** Flush until the queue is empty; a queue that never empties is a failure, not a hang. */
function flushAll(scene: Scene, gpu: ReturnType<typeof fakeGpu>): void {
  for (let pass = 0; scene.hasQueuedMeshes(); pass++) {
    assert.ok(pass < 1000, 'the mesh queue never drained');
    scene.flushPending(gpu.device, gpu.pipeline, 0);
  }
}

function upload(scene: Scene, gpu: ReturnType<typeof fakeGpu>, meshes: MeshData[]): void {
  scene.queueMeshes(meshes);
  flushAll(scene, gpu);
}

const pages = (scene: Scene): BatchedMesh[] => scene.getBatchedMeshes().filter((batch) => batch.indexFormat === 'uint16');
const buckets = (scene: Scene): BatchedMesh[] => scene.getBatchedMeshes().filter((batch) => batch.indexFormat === undefined);
/** `getCompactStats` without the page counters. */
const pagedAndDecodes = (scene: Scene) => { const stats = scene.getCompactStats(); return stats && { paged: stats.paged, decodes: stats.decodes }; };
const entitiesOf = (batches: readonly BatchedMesh[]): number[] => [...new Set(batches.flatMap((batch) => batch.expressIds))].sort((a, b) => a - b);

/** Compact meshes decoded to f32 since the current test began (the counter is process-wide). */
let decodedBefore = 0;
const decoded = (): number => compactHydrationStats().meshes - decodedBefore;
beforeEach(() => { decodedBefore = compactHydrationStats().meshes; });

// The record decoder is fetched on demand; a host awaits it before asking its workers for compact records.
await loadCompactGeometry();

/** A scene as the viewer's is for a compact load: quantized pipelines up, page code loaded. */
async function newScene(): Promise<Scene> {
  const scene = new Scene();
  scene.setQuantizedBatches(true);
  await loadCompactPages();
  return scene;
}

it('compact meshes take the bucket path before the page code is loaded', async (t) => {
  // `loadCompactPages` is process-wide and every test below awaits it, so this one is first in the file.
  if (createCompactPages({} as SceneCompactHost) !== null) { t.skip('the page code was already loaded in this process'); return; }
  const before = compactHydrationStats().meshes;
  const gpu = fakeGpu(), scene = new Scene();
  scene.setQuantizedBatches(true);
  const meshes = compactBatch([{ expressId: 91, at: [0, 0, 0], size: 1, color: GREY }]);
  upload(scene, gpu, meshes);
  assert.equal(pages(scene).length, 0);
  assert.deepEqual(entitiesOf(buckets(scene)), [91]);
  assert.equal(meshes[0].compact, undefined);
  assert.equal(compactHydrationStats().meshes - before, 1);
  assert.equal(scene.demoteCompact(), false);
  assert.deepEqual(scene.getBounds(), { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } });
});

describe('compact meshes in the scene', () => {
  it('draw from u16 pages holding the records as sent, without decoding a mesh', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    const meshes = compactBatch([
      { expressId: 11, at: [0, 0, 0], size: 1, color: GREY },
      { expressId: 12, at: [2, 0, 0], size: 1, color: GREY },
      { expressId: 13, at: [4, 0, 0], size: 2, color: RED },
    ]);
    const payload = meshes[0].compact!.payload;
    upload(scene, gpu, meshes);

    assert.equal(buckets(scene).length, 0);
    assert.equal(pages(scene).length, 2, 'one page per colour of the cell');
    const grey = pages(scene).find((page) => page.color === GREY)!;
    assert.deepEqual(grey.expressIds, [11, 12]);
    assert.equal(grey.indexCount, 72);
    assert.ok(grey.quantized, 'pages draw through the quantized pipeline');
    // The vertex buffer starts with the two grey boxes' records, byte for byte.
    assert.deepEqual(bytesOf(grey.vertexBuffer).subarray(0, 16 * 12), payload.records.subarray(0, 16 * 12));
    // Indices are rebased by each mesh's vertex base in the page.
    const indices = new Uint16Array(bytesOf(grey.indexBuffer).buffer, 0, 72);
    assert.deepEqual(Array.from(indices.subarray(0, 36)), Array.from(payload.indices.subarray(0, 36)));
    assert.deepEqual(Array.from(indices.subarray(36)), Array.from(payload.indices.subarray(36, 72), (i) => i + 8));

    assert.deepEqual(scene.getBounds(), { min: { x: 0, y: 0, z: 0 }, max: { x: 6, y: 2, z: 2 } });
    assert.deepEqual(scene.getEntityBoundingBox(13), { min: { x: 4, y: 0, z: 0 }, max: { x: 6, y: 2, z: 2 } });
    assert.deepEqual([...scene.getTriangleCounts()!], [[11, 12], [12, 12], [13, 12]]);
    assert.equal(decoded(), 0);
  });

  it('trim their growth slack at finalize, and only then report the stream settled', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    upload(scene, gpu, compactBatch([{ expressId: 1, at: [0, 0, 0], size: 1, color: GREY }]));
    upload(scene, gpu, compactBatch([{ expressId: 2, at: [3, 0, 0], size: 1, color: GREY }]));
    const [page] = pages(scene);
    assert.deepEqual(page.expressIds, [1, 2], 'a later batch joins the open page');
    assert.equal(scene.hasStreamingFragments(), true);
    const grown = page.vertexBuffer;
    scene.finalizeStreaming(gpu.device, gpu.pipeline);
    assert.equal(scene.hasStreamingFragments(), false);
    assert.equal(page.vertexBuffer.size, 16 * 12);
    assert.equal(page.indexBuffer.size, 72 * 2);
    assert.equal(isDestroyed(grown), true);
    // The trimmed buffers hold what the grown ones did.
    assert.deepEqual(bytesOf(page.vertexBuffer), bytesOf(grown).subarray(0, 16 * 12));
  });

  it('take the bucket path when the scene would not draw exactly their records', async () => {
    const cases: Array<[string, (scene: Scene, mesh: MeshData) => void]> = [
      ['an id re-homed after encoding', (_scene, mesh) => { mesh.expressId += 1_000_000; }],
      ['a recolour after encoding', (_scene, mesh) => { mesh.color = RED; }],
      ['a placed model', (scene) => { scene.setModelTranslation(0, [100, 0, 0]); }],
      ['an ephemeral stream', (scene) => { scene.setEphemeralStreamingMode(true); }],
      ['no quantized pipelines', (scene) => { scene.setQuantizedBatches(false); }],
    ];
    for (const [name, change] of cases) {
      const before = compactHydrationStats().meshes;
      const gpu = fakeGpu(), scene = await newScene();
      const meshes = compactBatch([{ expressId: 5, at: [0, 0, 0], size: 1, color: GREY }]);
      change(scene, meshes[0]);
      upload(scene, gpu, meshes);
      assert.equal(pages(scene).length, 0, name);
      assert.equal(buckets(scene).reduce((n, batch) => n + batch.indexCount, 0), 36, name);
      assert.equal(compactHydrationStats().meshes - before, 1, `${name}: decoded for the f32 upload`);
      assert.equal(meshes[0].compact, undefined, `${name}: handed on as an ordinary mesh`);
    }
  });

  it('take a removed entity off its page and leave every other mesh paged and undecoded', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    upload(scene, gpu, compactBatch([
      { expressId: 21, at: [0, 0, 0], size: 1, color: GREY },
      { expressId: 22, at: [2, 0, 0], size: 1, color: GREY },
      { expressId: 23, at: [4, 0, 0], size: 1, color: RED },
    ]));
    scene.finalizeStreaming(gpu.device, gpu.pipeline);
    const grey = pages(scene).find((page) => page.color === GREY)!;
    const red = pages(scene).find((page) => page.color === RED)!;

    assert.equal(scene.removeMeshesForEntity(22), true);
    scene.rebuildPendingBatches(gpu.device, gpu.pipeline);

    assert.equal(buckets(scene).length, 0, 'a removal moves nothing to buckets');
    assert.deepEqual(entitiesOf(pages(scene)), [21, 23]);
    assert.deepEqual(grey.expressIds, [21]);
    // 22's triangles repeat one vertex: empty triangles that draw (and pick) nothing. 21's are untouched.
    const indices = new Uint16Array(bytesOf(grey.indexBuffer).buffer, 0, 72);
    assert.deepEqual(new Set(indices.subarray(36)), new Set([8]));
    assert.ok(new Set(indices.subarray(0, 36)).size > 1);
    assert.equal(scene.getMeshDataPieces(21)?.length, 1);
    assert.equal(scene.getMeshDataPieces(22), undefined);
    assert.deepEqual([...scene.getTriangleCounts()!], [[21, 12], [23, 12]]);
    assert.deepEqual(scene.getBounds(), { min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 1, z: 1 } });
    assert.equal(decoded(), 0);

    // The last mesh of a page takes the page with it.
    assert.equal(scene.removeMeshesForEntity(23), true);
    assert.equal(pages(scene).length === 1 && pages(scene)[0] === grey, true);
    assert.equal(isDestroyed(red.vertexBuffer) && isDestroyed(red.indexBuffer), true, 'the empty page gave its buffers back');
    assert.equal(decoded(), 0);
  });

  it('discard a removed entity\'s still-queued compact meshes, so it does not come back (#11525)', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    scene.queueMeshes(compactBatch([
      { expressId: 41, at: [0, 0, 0], size: 1, color: GREY },
      { expressId: 42, at: [2, 0, 0], size: 1, color: GREY },
    ]));
    scene.removeMeshesForEntity(41); // before the first drain, with no stream running
    flushAll(scene, gpu);
    assert.deepEqual(entitiesOf(scene.getBatchedMeshes()), [42]);
    assert.equal(scene.getMeshDataPieces(41), undefined);
  });

  it('move only the edited entity to buckets, each mesh registered once', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    upload(scene, gpu, compactBatch([
      { expressId: 24, at: [0, 0, 0], size: 1, color: GREY },
      { expressId: 25, at: [2, 0, 0], size: 1, color: GREY },
      { expressId: 26, at: [4, 0, 0], size: 1, color: RED },
    ]));
    scene.finalizeStreaming(gpu.device, gpu.pipeline);

    assert.equal(scene.translateMeshesForEntity(25, [0, 3, 0]), true);
    scene.rebuildPendingBatches(gpu.device, gpu.pipeline);
    assert.deepEqual(entitiesOf(pages(scene)), [24, 26]);
    assert.deepEqual(entitiesOf(buckets(scene)), [25]);
    assert.equal(buckets(scene).reduce((n, batch) => n + batch.indexCount, 0), 36);
    assert.equal(scene.getMeshDataPieces(25)?.length, 1);
    assert.equal(scene.getMeshDataPieces(25)![0].compact, undefined);
    assert.equal(scene.getMeshDataPieces(24)![0].compact !== undefined, true, 'the others are still drawn from their records');
    assert.deepEqual(scene.getEntityBoundingBox(25), { min: { x: 2, y: 3, z: 0 }, max: { x: 3, y: 4, z: 1 } });
    assert.equal(decoded(), 1, 'only the edited mesh was decoded');

    // A recolour moves only what it recolours.
    scene.updateMeshColors(new Map([[26, [0, 0, 1, 1]]]), gpu.device, gpu.pipeline);
    assert.deepEqual(entitiesOf(pages(scene)), [24]);
    assert.deepEqual(entitiesOf(buckets(scene)), [25, 26]);
    assert.deepEqual([...scene.getTriangleCounts()!].sort((a, b) => a[0] - b[0]), [[24, 12], [25, 12], [26, 12]]);
    assert.equal(decoded(), 2);
  });

  it('keep a mesh the bucket path refuses on its page, and every other edit working', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    upload(scene, gpu, compactBatch([
      { expressId: 27, at: [0, 0, 0], size: 1, color: GREY },
      { expressId: 28, at: [2, 0, 0], size: 1, color: GREY },
      { expressId: 29, at: [4, 0, 0], size: 1, color: GREY },
    ]));
    scene.finalizeStreaming(gpu.device, gpu.pipeline);
    // 27 has no topology-safe f32 frame (what a mesh far outside its model's frame would hit).
    const host = scene as unknown as { refusesBucketPath: (mesh: MeshData) => boolean };
    const refuses = host.refusesBucketPath.bind(scene);
    host.refusesBucketPath = (mesh) => mesh.expressId === 27 || refuses(mesh);

    assert.throws(() => scene.translateMeshesForEntity(27, [0, 1, 0]), /no topology-safe f32 frame/);
    assert.deepEqual(entitiesOf(pages(scene)), [27, 28, 29], 'still drawn from its page');
    assert.equal(scene.getMeshDataPieces(27)?.length, 1);
    // Edits of the other meshes are not held hostage by the refused one (each used to throw the same error).
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(scene.translateMeshesForEntity(28, [0, 1, 0]), true);
    }
    scene.updateMeshColors(new Map([[29, RED]]), gpu.device, gpu.pipeline);
    scene.rebuildPendingBatches(gpu.device, gpu.pipeline);
    assert.deepEqual(entitiesOf(pages(scene)), [27]);
    assert.deepEqual(entitiesOf(buckets(scene)), [28, 29]);
    assert.deepEqual(scene.getEntityBoundingBox(28), { min: { x: 2, y: 2, z: 0 }, max: { x: 3, y: 3, z: 1 } });
    // A whole-scene demotion moves what it can and still reports the one it cannot.
    assert.throws(() => scene.demoteCompact(), /entity #27/);
    // The refused mesh can still be removed: it leaves its page without moving anywhere.
    assert.equal(scene.removeMeshesForEntity(27), true);
    assert.equal(pages(scene).length, 0);
    assert.equal(scene.getMeshDataPieces(27), undefined);
  });

  it('move to buckets when a model is placed after upload, drawn at the new place', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    upload(scene, gpu, compactBatch([{ expressId: 31, at: [0, 0, 0], size: 1, color: GREY }]));
    scene.finalizeStreaming(gpu.device, gpu.pipeline);
    scene.setModelTranslation(0, [10, 0, 0]);
    scene.rebuildPendingBatches(gpu.device, gpu.pipeline);
    assert.equal(pages(scene).length, 0);
    assert.deepEqual(scene.getBounds(), { min: { x: 10, y: 0, z: 0 }, max: { x: 11, y: 1, z: 1 } });
  });

  it('judge a page again when one mesh leaves it and another joins it in the same flush', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    upload(scene, gpu, compactBatch([
      { expressId: 31, at: [0, 0, 0], size: 1, color: GREY },
      { expressId: 32, at: [2, 0, 0], size: 1, color: GREY },
    ]));
    const [page] = pages(scene);
    const visibility = new BatchVisibilityCache(), hidden = new Set([33]);
    assert.equal(visibility.classify(page, 1, hidden, null), 'all');
    // Mid-stream: 31 is deleted and a hidden mesh joins the same page, so the page keeps two entries.
    scene.removeMeshesForEntity(31);
    upload(scene, gpu, compactBatch([{ expressId: 33, at: [4, 0, 0], size: 1, color: GREY }]));
    assert.deepEqual(page.expressIds, [32, 33]);
    assert.notEqual(visibility.classify(page, 1, hidden, null), 'all', 'the hidden newcomer is not drawn on a stale verdict');
  });

  it('upload queued meshes in the drain that runs a page demotion, so finalize settles', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    upload(scene, gpu, compactBatch([{ expressId: 34, at: [0, 0, 0], size: 1, color: GREY }]));
    assert.equal(scene.canPartitionBatch(pages(scene)[0]), false); // a split request for the next drain
    scene.queueMeshes(compactBatch([{ expressId: 35, at: [2, 0, 0], size: 1, color: RED }]));
    scene.finalizeStreaming(gpu.device, gpu.pipeline);
    assert.deepEqual(entitiesOf(buckets(scene)), [34]);
    assert.deepEqual(entitiesOf(pages(scene)), [35], 'the tail mesh was uploaded and its page trimmed at finalize');
    assert.equal(scene.hasStreamingFragments(), false);
  });

  it('leave an empty store as it starts: no origin carried over, nothing left to settle', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    upload(scene, gpu, compactBatch([{ expressId: 36, at: [0, 0, 0], size: 1, color: GREY }]));
    assert.equal(scene.hasStreamingFragments(), true, 'the page still has growth slack');
    scene.removeMeshesForEntity(36);
    assert.equal(pages(scene).length, 0);
    assert.equal(scene.hasStreamingFragments(), false);
    // The store-wide origin goes with the last page, so the next model's first window picks its own.
    const store = (scene as unknown as { compact: { store: { origin: unknown } } }).compact.store;
    assert.equal(store.origin, null);
  });

  it('ask a refused mesh once: a page that keeps it draws whole without failing every frame', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    upload(scene, gpu, compactBatch([
      { expressId: 38, at: [0, 0, 0], size: 1, color: GREY },
      { expressId: 39, at: [2, 0, 0], size: 1, color: GREY },
    ]));
    scene.finalizeStreaming(gpu.device, gpu.pipeline);
    const host = scene as unknown as { refusesBucketPath: (mesh: MeshData) => boolean };
    const refuses = host.refusesBucketPath.bind(scene);
    host.refusesBucketPath = (mesh) => mesh.expressId === 38 || refuses(mesh);
    for (let frame = 0; frame < 3; frame++) {
      const [page] = pages(scene);
      scene.canPartitionBatch(page);
      scene.flushPending(gpu.device, gpu.pipeline, 0); // never throws
    }
    assert.deepEqual(entitiesOf(pages(scene)), [38]);
    assert.deepEqual(entitiesOf(buckets(scene)), [39]);
    // The page left holds only the refused mesh: a frame's split request no longer keeps the scene unsettled.
    assert.equal(scene.canPartitionBatch(pages(scene)[0]), false);
    assert.equal(scene.hasQueuedMeshes(), false);
  });

  it('move to buckets on the next flush when a page would have to be split into sub-batches', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    upload(scene, gpu, compactBatch([
      { expressId: 61, at: [0, 0, 0], size: 1, color: GREY },
      { expressId: 62, at: [2, 0, 0], size: 1, color: GREY },
      { expressId: 63, at: [4, 0, 0], size: 1, color: RED },
    ]));
    scene.finalizeStreaming(gpu.device, gpu.pipeline);
    const page = pages(scene).find((batch) => batch.color === GREY)!;
    // Mid-frame the page cannot be partitioned and the batch list does not change under the draw loop.
    assert.equal(scene.canPartitionBatch(page), false);
    assert.equal(pages(scene).length, 2);
    assert.equal(scene.hasQueuedMeshes(), true, 'the frame loop is asked to flush');
    assert.equal(scene.flushPending(gpu.device, gpu.pipeline, 0), true);
    assert.deepEqual(entitiesOf(pages(scene)), [63], 'only that page\'s meshes moved');
    const [bucket] = buckets(scene);
    assert.deepEqual(entitiesOf([bucket]), [61, 62]);
    assert.equal(scene.canPartitionBatch(bucket), true);
    assert.equal(scene.hasQueuedMeshes(), false);
  });

  it('resolve the ids of a page that grew after it was first drawn', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    upload(scene, gpu, compactBatch([{ expressId: 5000, at: [0, 0, 0], size: 1, color: GREY }]));
    const [page] = pages(scene);
    assert.equal(batchEntityIdAnchor(page), 0, 'a fixed anchor, not the minimum of the ids seen so far');
    upload(scene, gpu, compactBatch([{ expressId: 3000, at: [2, 0, 0], size: 1, color: GREY }]));
    assert.deepEqual(pages(scene)[0].expressIds, [5000, 3000]);
    assert.equal(batchEntityIdAnchor(pages(scene)[0]), 0);
  });

  it('keep the batch list current when the scene replaces a bucket batch in place', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    const flat: MeshData = {
      expressId: 72, modelIndex: 0, color: GREY,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
    };
    upload(scene, gpu, [...compactBatch([{ expressId: 71, at: [0, 0, 0], size: 1, color: GREY }]), flat]);
    scene.finalizeStreaming(gpu.device, gpu.pipeline);
    const list = scene.getBatchedMeshes();
    assert.equal(scene.getBatchedMeshes() === list, true, 'one list while nothing changes');
    // What a residency restore does: a rebuilt batch takes the old one's slot in the flat list.
    const flatList = (scene as unknown as { batchedMeshes: BatchedMesh[] }).batchedMeshes;
    const rebuilt = { ...flatList[0] };
    flatList[0] = rebuilt;
    assert.equal(scene.getBatchedMeshes()[0] === rebuilt, true);
    assert.equal(scene.getBatchedMeshes().length, list.length);
  });

  it('upload again, still compact, to the device that replaces a lost one', async () => {
    const lost = fakeGpu(), scene = await newScene();
    upload(scene, lost, compactBatch([
      { expressId: 81, at: [0, 0, 0], size: 1, color: GREY },
      { expressId: 82, at: [2, 0, 0], size: 1, color: GREY },
    ]));
    scene.finalizeStreaming(lost.device, lost.pipeline);
    const dead = pages(scene)[0].vertexBuffer;

    scene.prepareDeviceRecovery();
    assert.equal(pages(scene).length, 0);
    assert.equal(isDestroyed(dead), false, 'nothing is called on the lost device');
    assert.equal(scene.hasQueuedMeshes(), true);

    const next = fakeGpu();
    scene.flushPending(next.device, next.pipeline, 0);
    const [page] = pages(scene);
    assert.deepEqual(page.expressIds, [81, 82]);
    assert.equal(page.vertexBuffer === dead, false);
    assert.equal(page.vertexBuffer.size, 16 * 12, 'trimmed at once: no stream is left to settle it');
    assert.equal(scene.hasStreamingFragments(), false);
    assert.equal(scene.getMeshDataPieces(81)?.length, 1);
    assert.deepEqual([...scene.getTriangleCounts()!], [[81, 12], [82, 12]]);
    assert.equal(decoded(), 0);
  });

  it('come back as pages through the renderer\'s whole recovery sequence, and the scene settles (#11525)', async () => {
    // device-recovery.ts: prepare (pages queued again), discard, teardown and init turn the quantized pipelines
    // off, prepare again, pipelines back on, restore, prepare once more. Sent to the bucket queue while the
    // pipelines were off, the queued meshes became streaming fragments no stream finalized: the scene never
    // settled after a device loss once a page outlived the load (lane L5 GPU qualification).
    const lost = fakeGpu(), scene = await newScene();
    upload(scene, lost, compactBatch(Array.from({ length: 6 }, (_, i) => ({ expressId: 320 + i, at: [i * 2, 0, 0] as [number, number, number], size: 1, color: i % 2 ? GREY : RED }))));
    scene.finalizeStreaming(lost.device, lost.pipeline);
    assert.equal(scene.prepareDeviceRecovery().ok, true);
    scene.discardGpuResourcesForRecovery();
    scene.setQuantizedBatches(false);
    scene.setQuantizedBatches(false);
    assert.equal(scene.prepareDeviceRecovery().ok, true);
    scene.setQuantizedBatches(true);
    const next = fakeGpu();
    scene.restoreGpuResourcesAfterRecovery(next.device, next.pipeline);
    assert.equal(scene.prepareDeviceRecovery().ok, true);
    flushAll(scene, next);
    assert.deepEqual(entitiesOf(pages(scene)), [320, 321, 322, 323, 324, 325]);
    assert.equal(buckets(scene).length, 0);
    assert.equal(scene.hasStreamingFragments(), false, 'nothing is left for a finalize that never comes');
    assert.equal(decoded(), 0);
  });

  it('decode queued meshes at the next drain, into buckets, when the quantized pipelines stay off (#11525)', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    scene.queueMeshes(compactBatch([{ expressId: 330, at: [0, 0, 0], size: 1, color: GREY }]));
    scene.setQuantizedBatches(false);
    assert.equal(scene.hasQueuedMeshes(), true, 'still queued, still compact');
    flushAll(scene, gpu);
    assert.equal(pages(scene).length, 0);
    assert.deepEqual(entitiesOf(buckets(scene)), [330]);
    assert.equal(scene.getMeshDataPieces(330)?.[0].compact, undefined);
    assert.equal(scene.hasStreamingFragments(), false, 'appended outside a stream: no fragment waits for a finalize');
  });

  it('recover as pages after a device loss even when a demotion was pending', async () => {
    const lost = fakeGpu(), scene = await newScene();
    upload(scene, lost, compactBatch([{ expressId: 101, at: [0, 0, 0], size: 1, color: GREY }]));
    scene.finalizeStreaming(lost.device, lost.pipeline);
    scene.canPartitionBatch(pages(scene)[0]); // asks for a demotion at the next flush
    scene.prepareDeviceRecovery();
    const next = fakeGpu();
    scene.flushPending(next.device, next.pipeline, 0);
    assert.deepEqual(entitiesOf(pages(scene)), [101], 'the request died with the pages it was about');
    assert.equal(decoded(), 0);
  });

  it('keep drawing from pages when the bucket path refuses the meshes', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    upload(scene, gpu, compactBatch([
      { expressId: 111, at: [0, 0, 0], size: 1, color: GREY },
      { expressId: 112, at: [2, 0, 0], size: 1, color: GREY },
    ]));
    scene.finalizeStreaming(gpu.device, gpu.pipeline);
    const [page] = pages(scene);
    // The append validates before it changes anything; a refusal there leaves the scene as it was.
    const host = scene as unknown as { appendToBatches: (...args: unknown[]) => void };
    const append = host.appendToBatches;
    host.appendToBatches = () => { throw new Error('no topology-safe frame'); };
    assert.throws(() => scene.demoteCompact(), /no topology-safe frame/);
    host.appendToBatches = append;

    // Identity as a boolean: a failing comparison of page objects would print their whole buffers.
    assert.equal(pages(scene).length === 1 && pages(scene)[0] === page, true, 'the page is still in the draw list');
    assert.equal(isDestroyed(page.vertexBuffer), false);
    assert.equal(scene.getMeshDataPieces(111)?.length, 1, 'registered once, not dropped and not doubled');
    // A later attempt completes the move.
    assert.equal(scene.demoteCompact(), true);
    scene.rebuildPendingBatches(gpu.device, gpu.pipeline);
    assert.equal(pages(scene).length, 0);
    assert.deepEqual(entitiesOf(buckets(scene)), [111, 112]);
    assert.equal(scene.getMeshDataPieces(111)?.length, 1);
  });

  it('leave the meshes to their buckets when only the GPU build of those fails', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    upload(scene, gpu, compactBatch([{ expressId: 115, at: [0, 0, 0], size: 1, color: GREY }]));
    scene.finalizeStreaming(gpu.device, gpu.pipeline);
    const device = gpu.device as unknown as { createBuffer: (descriptor: GPUBufferDescriptor) => unknown };
    const createBuffer = device.createBuffer;
    device.createBuffer = () => { throw new Error('out of GPU memory'); };
    assert.throws(() => scene.demoteCompact(), /out of GPU memory/);
    device.createBuffer = createBuffer;

    // The bucket owns the mesh, as it would any mesh whose batch failed to build: one registration, no page.
    assert.equal(pages(scene).length, 0);
    assert.equal(scene.getMeshDataPieces(115)?.length, 1);
    scene.rebuildPendingBatches(gpu.device, gpu.pipeline);
    assert.deepEqual(entitiesOf(buckets(scene)), [115]);
    assert.equal(buckets(scene).reduce((n, batch) => n + batch.indexCount, 0), 36);
  });

  it('send a queued mesh that stopped being compact to the bucket path', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    const meshes = compactBatch([
      { expressId: 121, at: [0, 0, 0], size: 1, color: GREY },
      { expressId: 122, at: [2, 0, 0], size: 1, color: GREY },
    ]);
    scene.queueMeshes(meshes);
    meshes[1].indices = meshes[1].indices.slice(0, 3); // something replaced its geometry before the upload
    flushAll(scene, gpu);
    assert.deepEqual(entitiesOf(pages(scene)), [121]);
    assert.deepEqual(entitiesOf(buckets(scene)), [122]);
    assert.equal(buckets(scene).reduce((n, batch) => n + batch.indexCount, 0), 3, 'drawn with the geometry it now holds');
  });

  it('take the bucket path when appended directly, with bounds that follow their placement', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    const meshes = compactBatch([{ expressId: 131, at: [0, 0, 0], size: 1, color: GREY }]);
    scene.appendToBatches(meshes, gpu.device, gpu.pipeline);
    assert.equal(pages(scene).length, 0);
    assert.equal(meshes[0].compact, undefined);
    scene.setModelTranslation(0, [5, 0, 0]);
    scene.rebuildPendingBatches(gpu.device, gpu.pipeline);
    assert.deepEqual(scene.getEntityBoundingBox(131), { min: { x: 5, y: 0, z: 0 }, max: { x: 6, y: 1, z: 1 } });
  });

  it('take the bucket path when their origin was rewritten after the worker encoded them', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    const meshes = compactBatch([
      { expressId: 151, at: [0, 0, 0], size: 1, color: GREY },
      { expressId: 152, at: [2, 0, 0], size: 1, color: GREY },
    ]);
    meshes[1].origin = [10, 0, 0]; // moved through its origin: the records still say where it was
    upload(scene, gpu, meshes);
    assert.deepEqual(entitiesOf(pages(scene)), [151]);
    assert.deepEqual(entitiesOf(buckets(scene)), [152]);
    assert.equal(scene.getEntityBoundingBox(152)!.min.x, 12);
  });

  it('judge a queued mesh again at upload: one re-homed in the queue takes the bucket path', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    const meshes = compactBatch([
      { expressId: 181, at: [0, 0, 0], size: 1, color: GREY },
      { expressId: 182, at: [2, 0, 0], size: 1, color: GREY },
    ]);
    scene.queueMeshes(meshes);
    meshes[1].expressId = 183; // its records still carry id 182
    flushAll(scene, gpu);
    assert.deepEqual(entitiesOf(pages(scene)), [181]);
    assert.deepEqual(entitiesOf(buckets(scene)), [183]);
  });

  it('are ordinary meshes when appended again after the flat geometry was cleared', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    const meshes = compactBatch([{ expressId: 161, at: [0, 0, 0], size: 1, color: GREY }]);
    upload(scene, gpu, meshes);
    scene.clearFlatGeometry();
    scene.appendToBatches(meshes, gpu.device, gpu.pipeline);
    assert.equal(pages(scene).length, 0);
    assert.equal(scene.getMeshDataPieces(161)!.some((piece) => piece.compact), false, 'the placed copy made at page time is decoded too');
  });

  it('queue every mesh again when an upload dies part-way', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    upload(scene, gpu, compactBatch([{ expressId: 171, at: [0, 0, 0], size: 1, color: GREY }]));
    scene.queueMeshes(compactBatch([{ expressId: 172, at: [2, 0, 0], size: 1, color: RED }]));
    const write = gpu.device.queue.writeBuffer;
    gpu.device.queue.writeBuffer = () => { throw new Error('device lost'); };
    assert.throws(() => scene.flushPending(gpu.device, gpu.pipeline, 0), /device lost/);
    assert.equal(pages(scene).length, 0, 'no half-written page is drawn');
    assert.equal(scene.getMeshDataPieces(171), undefined);
    gpu.device.queue.writeBuffer = write;
    flushAll(scene, gpu);
    assert.deepEqual(entitiesOf(pages(scene)).sort(), [171, 172]);
    assert.equal(scene.getMeshDataPieces(171)?.length, 1);
    assert.equal(decoded(), 0);
  });

  it('give a highlight copy of a paged piece the page frame', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    upload(scene, gpu, compactBatch([{ expressId: 141, at: [3, 0, 0], size: 1, color: GREY }]));
    const [page] = pages(scene);
    const piece = scene.getMeshDataPieces(141)![0];
    assert.deepEqual(scene.getIndividualMeshFrame(piece), { sharedOrigin: page.origin, quantized: true });
  });

  it('are dropped with the rest of the flat geometry', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    upload(scene, gpu, compactBatch([{ expressId: 41, at: [0, 0, 0], size: 1, color: GREY }]));
    const [page] = pages(scene);
    scene.clear();
    assert.equal(scene.getBatchedMeshes().length, 0);
    assert.equal(isDestroyed(page.vertexBuffer), true);
    assert.equal(scene.hasStreamingFragments(), false);
    assert.equal(scene.demoteCompact(), false);
  });

  it('wait queued, still compact, while the quantized pipeline probe is in flight, then draw from pages', async () => {
    // The viewer probes the quantized pipelines asynchronously when the renderer starts; a load that
    // raced the probe used to decode whatever arrived first to buckets for good (lane L9: FZK always
    // ended with 0 pages, advanced_model with 0 or 59-90 between loads of one build).
    const gpu = fakeGpu(), scene = new Scene();
    await loadCompactPages();
    const settle = scene.beginQuantizedProbe();
    assert.equal(scene.quantizedBatchesPending, true);
    const meshes = compactBatch([{ expressId: 401, at: [0, 0, 0], size: 1, color: GREY }, { expressId: 402, at: [2, 0, 0], size: 1, color: RED }]);
    scene.queueMeshes(meshes);
    for (let i = 0; i < 3; i++) scene.flushPending(gpu.device, gpu.pipeline, 0);
    scene.finalizeStreaming(gpu.device, gpu.pipeline); // a stream that ends before the probe does
    assert.equal(scene.getBatchedMeshes().length, 0, 'nothing drawn yet');
    assert.equal(scene.hasQueuedMeshes(), true);
    assert.ok(meshes.every((mesh) => mesh.compact), 'still compact');
    assert.equal(decoded(), 0);

    scene.setQuantizedBatches(true); // the probe's outcome is applied before its hold is released
    settle();
    settle(); // a second call is a no-op
    assert.equal(scene.quantizedBatchesPending, false);
    flushAll(scene, gpu);
    assert.deepEqual(entitiesOf(pages(scene)), [401, 402]);
    assert.equal(buckets(scene).length, 0);
    assert.equal(pages(scene)[0].vertexBuffer.size, 8 * 12, 'trimmed at the drain that filled it: its stream had ended');
    assert.equal(scene.hasStreamingFragments(), false);
    assert.equal(decoded(), 0);
    assert.deepEqual(pagedAndDecodes(scene), { paged: 2, decodes: {} });
  });

  it('decode the waiting queue to buckets when the probe finds no quantized pipelines', async () => {
    const gpu = fakeGpu(), scene = new Scene();
    await loadCompactPages();
    const settle = scene.beginQuantizedProbe();
    scene.queueMeshes(compactBatch([{ expressId: 411, at: [0, 0, 0], size: 1, color: GREY }]));
    scene.flushPending(gpu.device, gpu.pipeline, 0);
    scene.finalizeStreaming(gpu.device, gpu.pipeline);
    assert.equal(scene.getBatchedMeshes().length, 0);
    settle(); // the probe failed: the pipelines stay off
    flushAll(scene, gpu);
    assert.deepEqual(entitiesOf(buckets(scene)), [411]);
    assert.equal(pages(scene).length, 0);
    assert.deepEqual(pagedAndDecodes(scene), { paged: 0, decodes: { pipelines: 1 } });
  });

  it('count why each mesh a load sends to buckets was decoded', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    const meshes = compactBatch([
      { expressId: 421, at: [0, 0, 0], size: 1, color: GREY },
      { expressId: 422, at: [2, 0, 0], size: 1, color: GREY },
      { expressId: 423, at: [4, 0, 0], size: 1, color: GREY },
    ]);
    meshes[1].color = RED; // recoloured after encoding: its records carry the old colour salt
    meshes[2].origin = [1, 0, 0]; // moved after encoding
    upload(scene, gpu, meshes);
    assert.deepEqual(entitiesOf(pages(scene)), [421]);
    assert.deepEqual(pagedAndDecodes(scene), { paged: 1, decodes: { lane: 1, moved: 1 } });
    scene.clear();
    assert.deepEqual(pagedAndDecodes(scene), { paged: 0, decodes: {} });
  });

  it('land on the lattice nodes the bucket path draws the same mesh on, whatever the mesh frame', async () => {
    // The bucket path quantizes onto 2^-10 nodes relative to its batch frame origin; compact records
    // hold absolute nodes. With the frame at an arbitrary point (the first mesh's box centre) the two
    // put a vertex up to a step apart, so the flag moved every edge and flipped near-coplanar faces
    // (lane L9: pixel gate 0.12-7.4% on every model). The frame now snaps to the 2^-9 lattice.
    const box: Box = { expressId: 431, at: [5.1234, 2.71828, -3.14159], size: 1.0007, color: GREY };
    const origin: [number, number, number] = [5, 2, -3];
    const positions = new Float32Array(24), normals = new Float32Array(24);
    for (let corner = 0; corner < 8; corner++) {
      for (let axis = 0; axis < 3; axis++) {
        positions[corner * 3 + axis] = boxCorner(box, corner, axis) - origin[axis];
        normals[corner * 3 + axis] = ((corner >> axis) & 1) * 2 - 1;
      }
    }
    const flat: MeshData = { expressId: 431, modelIndex: 0, color: GREY, origin, positions, normals, indices: new Uint32Array(BOX_TRIANGLES) };
    // Each batch's eight vertices as absolute lattice node indices (world * 1024), sorted.
    const nodes = (batch: BatchedMesh): string[] => {
      const view = new DataView(bytesOf(batch.vertexBuffer).buffer);
      const out: string[] = [];
      for (let v = 0; v < 8; v++) {
        out.push([0, 1, 2].map((axis) => {
          const world = batch.origin![axis] + batch.quantized!.min[axis] + view.getUint16(v * 12 + axis * 2, true) * batch.quantized!.step;
          assert.ok(Number.isInteger(world * 1024), `axis ${axis}: ${world} is a lattice node`);
          return world * 1024;
        }).join());
      }
      return [...new Set(out)].sort();
    };
    const gpuOff = fakeGpu(), off = await newScene();
    upload(off, gpuOff, [flat]);
    off.finalizeStreaming(gpuOff.device, gpuOff.pipeline);
    const [bucket] = buckets(off);
    assert.ok(bucket.quantized, 'the bucket batch is quantized');
    const gpuOn = fakeGpu(), on = await newScene();
    upload(on, gpuOn, compactBatch([box]));
    const [page] = pages(on);
    assert.deepEqual(nodes(bucket), nodes(page));
  });

  it('mix with f32 meshes of the same batch', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    const flat: MeshData = {
      expressId: 52, modelIndex: 0, color: GREY,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
    };
    upload(scene, gpu, [...compactBatch([{ expressId: 51, at: [0, 0, 0], size: 1, color: GREY }]), flat]);
    assert.deepEqual(entitiesOf(pages(scene)), [51]);
    assert.deepEqual(entitiesOf(buckets(scene)), [52]);
    assert.equal(decoded(), 0);
  });
});

/**
 * 40 small boxes (smaller than a LOD cell: they collapse) and 20 large ones along x. One colour, so the
 * bucket path files them in one bucket per 32 m chunk cell; a box's id is `firstId + index`.
 */
function lodBoxes(firstId: number, x0: number, length: number, color: Rgba = GREY): Box[] {
  return Array.from({ length: 60 }, (_, i) => ({
    expressId: firstId + i, at: [x0 + (i * length) / 60, (i % 3) * 0.25, 0] as [number, number, number], size: i % 3 === 0 ? 2 : 0.1, color,
  }));
}

/** A scene that builds LOD1 with 32 m chunk cells: pages when `compact`, the bucket path (f32 meshes) otherwise. */
async function lodScene(compact: boolean): Promise<Scene> {
  const scene = compact ? await newScene() : new Scene();
  scene.setQuantizedBatches(true);
  scene.setSpatialChunking({ cellSize: 32 });
  scene.setLodBuildsEnabled(true);
  return scene;
}

/** The world positions (in lattice steps) of the non-empty triangles of `indices` over a quantized batch's records. */
function triangles(batch: BatchedMesh, indices: ArrayLike<number>, from = 0, to = indices.length): string[] {
  const view = new DataView(bytesOf(batch.vertexBuffer).buffer), q = batch.quantized!;
  const out: string[] = [];
  for (let t = from; t < to; t += 3) {
    const corners = [indices[t], indices[t + 1], indices[t + 2]];
    if (corners[0] === corners[1] || corners[1] === corners[2] || corners[0] === corners[2]) continue;
    out.push(corners.map((v) => [0, 1, 2].map((axis) => Math.round((batch.origin![axis] + q.min[axis] + view.getUint16(v * 12 + axis * 2, true) * q.step) * 1024)).join(' ')).sort().join('|'));
  }
  return out;
}

const u16 = (buffer: GPUBuffer): Uint16Array => new Uint16Array(bytesOf(buffer).buffer);

/** The same box within half a lattice step: rows carry the source box, the decoded f32 meshes of these fixtures its lattice nodes. */
function assertSameBox(a: BatchedMesh['bounds'], b: BatchedMesh['bounds'], message: string): void {
  for (const corner of ['min', 'max'] as const) {
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(a![corner][axis] - b![corner][axis]) <= 2 ** -11, `${message}: ${corner}[${axis}] ${a![corner][axis]} vs ${b![corner][axis]}`);
  }
}

/** A page's LOD1 triangles, over its parts. */
function pageLod1(page: BatchedMesh): string[] {
  const lod1 = u16(page.lod1IndexBuffer!);
  return page.lodParts!.flatMap((part) => triangles(page, lod1, part.lod1Start, part.lod1Start + part.lod1Count));
}

/** End the stream and run the drains that build the pages' parts (a slice per drain, compact-lod.ts). */
function settle(scene: Scene, gpu: ReturnType<typeof fakeGpu>): void {
  scene.finalizeStreaming(gpu.device, gpu.pipeline);
  flushAll(scene, gpu);
}

describe('compact pages take the decisions of the bucket batches they stand in for', () => {
  it('build each bucket\'s LOD1 over their pages, the triangles the bucket path builds for the same meshes', async () => {
    const boxes = [...lodBoxes(1000, 0, 28), ...lodBoxes(2000, 0, 28, RED)];
    const off = await lodScene(false), gpuOff = fakeGpu();
    const flat = compactBatch(boxes);
    for (const mesh of flat) materializeCompactMesh(mesh);
    upload(off, gpuOff, flat);
    settle(off, gpuOff);
    assert.equal(buckets(off).length, 2);

    const on = await lodScene(true), gpuOn = fakeGpu(), decodedOff = decoded();
    upload(on, gpuOn, compactBatch(boxes));
    settle(on, gpuOn);
    assert.equal(buckets(on).length, 0);
    assert.equal(decoded() - decodedOff, 0, 'built from the records: no mesh decoded');
    for (const color of [GREY, RED]) {
      const bucket = buckets(off).find((b) => b.color === color)!, page = pages(on).find((p) => p.color === color)!;
      assert.ok(bucket.lod1IndexBuffer && bucket.lod1IndexCount! < bucket.indexCount, 'the bucket batch has a LOD1 range');
      assert.equal(page.lodParts?.length, 1);
      const [part] = page.lodParts!;
      assertSameBox(part.bounds, bucket.bounds, 'the part decides on the bucket batch\'s box');
      assert.deepEqual({ start: part.lod0Start, count: part.lod0Count }, { start: 0, count: page.indexCount });
      const bucketLod1 = triangles(bucket, new Uint32Array(bytesOf(bucket.lod1IndexBuffer).buffer, 0, bucket.lod1IndexCount)).sort();
      assert.deepEqual(pageLod1(page).sort(), bucketLod1);
      // Full detail is every triangle of the page, as before.
      assert.equal(triangles(page, u16(page.indexBuffer)).length, 60 * 12);
    }
    assert.equal(on.getCompactStats()?.paged, 120);
  });

  it('take a bucket\'s decision once over every page that holds part of it, on the bucket\'s box', async () => {
    // Compact cells 0 ([-16, 16) m) and 1 ([16, 48) m) both hold boxes of chunk cell 0 ([0, 32) m); cell 1 also of chunk cell 1.
    const near = lodBoxes(1000, 0, 15), far = lodBoxes(2000, 17, 14), beyond = lodBoxes(3000, 33, 12);
    const on = await lodScene(true), gpu = fakeGpu();
    upload(on, gpu, [...compactBatch(near), ...compactBatch([...far, ...beyond], 1)]);
    settle(on, gpu);
    const [page0, page1] = pages(on);
    assert.equal(pages(on).length, 2);
    assert.equal(page0.lodParts?.length, 1);
    assert.equal(page1.lodParts?.length, 2, 'the second page holds parts of two buckets');
    assert.equal(page1.lodParts![0].bounds, page0.lodParts![0].bounds, 'one box for chunk cell 0, shared by both pages');
    assert.deepEqual(page0.lodParts![0].bounds.min, [0, 0, 0]);
    assert.ok(page0.lodParts![0].bounds.max[0] > 32, 'it reaches the far page\'s boxes of chunk cell 0');
    assert.deepEqual(page1.lodParts![1].bounds.min, [33, 0, 0]);
    // Each part's LOD0 range holds exactly its meshes' triangles, and the parts cover the page.
    assert.equal(page1.lodParts![0].lod0Count + page1.lodParts![1].lod0Count, page1.indexCount);
    assert.deepEqual(entitiesOf([page1]), entitiesOf([page1]).filter((id) => id >= 2000));

    const off = await lodScene(false), gpuOff = fakeGpu();
    const flat = [...compactBatch(near), ...compactBatch([...far, ...beyond], 1)];
    for (const mesh of flat) materializeCompactMesh(mesh);
    upload(off, gpuOff, flat);
    settle(off, gpuOff);
    const cell0 = buckets(off).find((b) => b.bounds!.min[0] === 0)!;
    assertSameBox(cell0.bounds, page0.lodParts![0].bounds, 'chunk cell 0');
    const bucketLod1 = triangles(cell0, new Uint32Array(bytesOf(cell0.lod1IndexBuffer!).buffer, 0, cell0.lod1IndexCount)).sort();
    const lod1Of = (page: BatchedMesh, part: number) => triangles(page, u16(page.lod1IndexBuffer!), page.lodParts![part].lod1Start, page.lodParts![part].lod1Start + page.lodParts![part].lod1Count);
    assert.deepEqual([...lod1Of(page0, 0), ...lod1Of(page1, 0)].sort(), bucketLod1, 'per-page clustering: no entity spans the two pages here');
  });

  it('move the meshes of a bucket that would stay exact f32 (#9068) to buckets at the end of the stream', async () => {
    const on = await lodScene(true), gpu = fakeGpu();
    const exact = compactBatch([{ expressId: 1, at: [0, 0, 0], size: 1, color: GREY }, { expressId: 2, at: [3, 0, 0], size: 1, color: GREY }]);
    // Row 1 is on level 11: the encoder moved it there because level 10 collapsed it. Its bucket batch would stay f32.
    exact[1].compact!.payload.table[1 * 7 + 5] = 11;
    const other = compactBatch([{ expressId: 3, at: [0, 0, 0], size: 1, color: RED }]);
    upload(on, gpu, [...exact, ...other]);
    assert.deepEqual(entitiesOf(pages(on)), [1, 2, 3], 'paged while the model streams');
    settle(on, gpu);
    assert.deepEqual(entitiesOf(pages(on)), [3]);
    assert.deepEqual(entitiesOf(buckets(on)), [1, 2]);
    assert.equal(on.getCompactStats()?.decodes.exact, 2);
    assert.equal(decoded(), 2);
  });

  it('keep a bucket paged whose mesh only outgrew its window (level 9)', async () => {
    const on = await lodScene(true), gpu = fakeGpu();
    const meshes = compactBatch([{ expressId: 1, at: [0, 0, 0], size: 1, color: GREY }, { expressId: 2, at: [3, 0, 0], size: 1, color: GREY }]);
    meshes[1].compact!.payload.table[1 * 7 + 5] = 9;
    upload(on, gpu, meshes);
    settle(on, gpu);
    assert.deepEqual(entitiesOf(pages(on)), [1, 2]);
    assert.equal(on.getCompactStats()?.decodes.exact, undefined);
  });

  it('move the meshes of a bucket wider than the u16 lattice range to buckets', async () => {
    const on = await lodScene(true), gpu = fakeGpu();
    // 66 m apart on x, in two compact cells; with chunking off the bucket path files both in one batch.
    on.setSpatialChunking(null);
    upload(on, gpu, [...compactBatch([{ expressId: 1, at: [-10, 0, 0], size: 1, color: GREY }]), ...compactBatch([{ expressId: 2, at: [55, 0, 0], size: 1, color: GREY }], 1)]);
    settle(on, gpu);
    assert.equal(pages(on).length, 0);
    assert.equal(on.getCompactStats()?.decodes.exact, 2);
  });

  it('empty a retired entity\'s LOD1 triangles and keep every other range', async () => {
    const on = await lodScene(true), gpu = fakeGpu();
    upload(on, gpu, compactBatch(lodBoxes(1000, 0, 28)));
    settle(on, gpu);
    const [page] = pages(on);
    const before = pageLod1(page).length;
    // Box 1000 is large (it keeps LOD1 triangles); a removal retires it.
    assert.equal(on.removeMeshesForEntity(1000), true);
    assert.ok(page.lodParts, 'the page keeps its parts');
    assert.equal(pageLod1(page).length, before - 12, 'its 12 triangles are empty now');
    assert.equal(on.getCompactStats()?.paged, 59);
  });

  it('drop a page\'s parts when a mesh joins it, and build them again when that stream ends', async () => {
    const on = await lodScene(true), gpu = fakeGpu();
    upload(on, gpu, compactBatch(lodBoxes(1000, 0, 28)));
    settle(on, gpu);
    const [page] = pages(on);
    const lod1 = page.lod1IndexBuffer!;
    upload(on, gpu, compactBatch([{ expressId: 5000, at: [1, 1, 1], size: 3, color: GREY }]));
    assert.equal(pages(on).length, 1);
    assert.equal(page.lodParts, undefined, 'the parts no longer cover the page');
    assert.equal(page.lod1IndexBuffer, undefined);
    assert.equal(isDestroyed(lod1), true);
    settle(on, gpu);
    assert.equal(page.lodParts?.[0].lod0Count, page.indexCount);
    assert.equal(triangles(page, u16(page.indexBuffer)).length, 61 * 12);
  });

  it('build the parts a page per drain, and report queued work until the last one is in', async () => {
    const on = await lodScene(true), gpu = fakeGpu();
    upload(on, gpu, [...compactBatch(lodBoxes(1000, 0, 15)), ...compactBatch(lodBoxes(2000, 17, 14), 1)]);
    on.finalizeStreaming(gpu.device, gpu.pipeline);
    assert.equal(on.hasQueuedMeshes(), true, 'the build is work the flush loop still has to do');
    assert.ok(pages(on).every((page) => page.lodParts === undefined), 'a page draws whole until its parts are installed');
    let drains = 0;
    for (; on.hasQueuedMeshes(); drains++) on.flushPending(gpu.device, gpu.pipeline, 0);
    assert.equal(drains, 5, 'two pages clustered, two installed, then the build ends: one step per drain at a zero budget');
    assert.ok(pages(on).every((page) => page.lodParts !== undefined));
  });

  it('drop the build when the pages change under it', async () => {
    const on = await lodScene(true), gpu = fakeGpu();
    upload(on, gpu, compactBatch(lodBoxes(1000, 0, 28)));
    on.finalizeStreaming(gpu.device, gpu.pipeline);
    assert.equal(on.removeMeshesForEntity(1000), true);
    assert.equal(on.hasQueuedMeshes(), false, 'a retire drops the planned build');
    assert.equal(pages(on)[0].lodParts, undefined, 'the page draws whole');
  });

  it('leave a page whole when one of its meshes is written while the build runs', async () => {
    const on = await lodScene(true), gpu = fakeGpu();
    const meshes = compactBatch(lodBoxes(1000, 0, 28));
    upload(on, gpu, meshes);
    on.finalizeStreaming(gpu.device, gpu.pipeline);
    meshes[5].positions = new Float32Array(meshes[5].positions); // a write: the mesh no longer has records
    assert.equal(meshes[5].compact, undefined);
    assert.doesNotThrow(() => flushAll(on, gpu));
    assert.equal(pages(on)[0].lodParts, undefined, 'its page keeps its own buffer');
  });

  it('group by each scene\'s own chunking when the same meshes are paged in two scenes (#11606)', async () => {
    const meshes = compactBatch([...lodBoxes(1000, 20, 4), ...lodBoxes(2000, 36, 4)], 1); // compact cell 1: [16, 48) m
    const wide = await lodScene(true), gpuWide = fakeGpu();
    wide.setSpatialChunking({ cellSize: 64 });
    upload(wide, gpuWide, meshes);
    settle(wide, gpuWide);
    assert.equal(pages(wide)[0].lodParts?.length, 1, '64 m chunks: one bucket');
    const narrow = await lodScene(true), gpuNarrow = fakeGpu();
    upload(narrow, gpuNarrow, meshes);
    settle(narrow, gpuNarrow);
    assert.equal(pages(narrow)[0].lodParts?.length, 2, '32 m chunks: two buckets, not the first scene\'s cached one');
  });

  it('keep pages whole when bucket batches build no LOD1', async () => {
    const gpu = fakeGpu(), scene = await newScene();
    scene.setSpatialChunking({ cellSize: 32 });
    upload(scene, gpu, compactBatch(lodBoxes(1000, 0, 28)));
    settle(scene, gpu);
    const [page] = pages(scene);
    assert.equal(page.lodParts, undefined);
    assert.equal(page.lod1IndexBuffer, undefined);
  });
});
