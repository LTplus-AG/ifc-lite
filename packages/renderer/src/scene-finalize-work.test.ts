/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The work a cold load's finalize does after the last batch arrived, counted
 * through the real Scene streaming and finalize code (only the GPU device is a
 * recording stub). The geometry already went to the GPU once, as the
 * streaming fragments of the buckets finalize builds, so finalize must not
 * merge, quantize or upload those vertices again, nor re-check their f32
 * topology. Output identity: every final batch decodes to exactly what the full
 * rebuild produces (a snapshot capture forces that rebuild, which records the
 * merged bytes it uploads).
 */

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { diffCounters, perfCounters } from '@ifc-lite/load-trace';
import { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';
import type { BatchedMesh } from './types.js';
import type { SceneSnapshot } from './scene-snapshot.js';

Object.assign(globalThis, { GPUBufferUsage: { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 } });

type StubBuffer = { size: number; usage: number; bytes: Uint8Array; destroyed: boolean; destroy(): void };

function recordingDevice() {
  const work = { vertexWriteBytes: 0, indexWriteBytes: 0, copyBytes: 0, buffers: 0 };
  const device = {
    limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28 },
    createBuffer({ size, usage }: GPUBufferDescriptor): StubBuffer {
      work.buffers++;
      const buffer: StubBuffer = { size, usage, bytes: new Uint8Array(size), destroyed: false, destroy() { buffer.destroyed = true; } };
      return buffer;
    },
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      copyBufferToBuffer(from: StubBuffer, fromOffset: number, to: StubBuffer, toOffset: number, size: number) {
        assert.ok(!from.destroyed, 'copies only from live fragments');
        assert.ok(from.usage & GPUBufferUsage.COPY_SRC, 'the source allows copies');
        to.bytes.set(from.bytes.subarray(fromOffset, fromOffset + size), toOffset);
        work.copyBytes += size;
      },
      finish: () => ({}),
    }),
    queue: {
      submit() {},
      writeBuffer(buffer: StubBuffer, offset: number, data: ArrayBufferView) {
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        buffer.bytes.set(bytes, offset);
        if (buffer.usage & GPUBufferUsage.VERTEX) work.vertexWriteBytes += bytes.byteLength;
        if (buffer.usage & GPUBufferUsage.INDEX) work.indexWriteBytes += bytes.byteLength;
      },
    },
  } as unknown as GPUDevice;
  return { device, work };
}

const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as RenderPipeline;
const PALETTE: Array<[number, number, number, number]> = [[0.8, 0.2, 0.2, 1], [0.2, 0.7, 0.3, 1], [0.3, 0.3, 0.9, 1], [0.9, 0.9, 0.9, 1], [0.6, 0.5, 0.1, 1]];

/** An axis-aligned box of size `s` at (x, y, z), each face a 4×4 grid, local to a georeferenced origin. */
function box(id: number, x: number, y: number, z: number, s: number, color: [number, number, number, number]): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faces: Array<[number[], number[], number[], number[]]> = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0], [0, 0, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1], [0, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1]], [[0, 0, -1], [0, 1, 0], [1, 0, 0], [0, 0, 0]],
  ];
  const N = 4;
  for (const [n, u, v, o] of faces) {
    const base = positions.length / 3;
    for (let b = 0; b <= N; b++) for (let a = 0; a <= N; a++) {
      positions.push(...[0, 1, 2].map((axis) => [x, y, z][axis] + (o[axis] + (a / N) * u[axis] + (b / N) * v[axis]) * s));
      normals.push(...n);
    }
    for (let b = 0; b < N; b++) for (let a = 0; a < N; a++) {
      const c = base + b * (N + 1) + a;
      indices.push(c, c + 1, c + N + 2, c, c + N + 2, c + N + 1);
    }
  }
  return { expressId: id, modelIndex: 0, color, origin: [2_600_000, 1_200_000, 400],
    positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}

/** Boxes spread over several 32 m cells and colours, delivered in arrivals of 40. */
function arrivals(): MeshData[][] {
  const meshes: MeshData[] = [];
  let id = 1;
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) for (let k = 0; k < 4; k++) {
    meshes.push(box(id, i * 7.3 + 0.13, k * 3.1, j * 6.7 + 0.29, 0.4 + ((i + j + k) % 5) * 0.37, PALETTE[(i * 3 + j + k) % PALETTE.length]));
    id++;
  }
  const out: MeshData[][] = [];
  for (let at = 0; at < meshes.length; at += 40) out.push(meshes.slice(at, at + 40));
  return out;
}

function countFround<T>(run: () => T): { result: T; calls: number } {
  const original = Math.fround;
  let calls = 0;
  Math.fround = (x: number) => { calls++; return original(x); };
  try { return { result: run(), calls }; } finally { Math.fround = original; }
}

/** Flush until the queue is empty, failing fast (not spinning) if a flush stops making progress. */
function drain(scene: Scene, device: GPUDevice): void {
  for (let flushes = 0; scene.hasQueuedMeshes(); flushes++) {
    assert.ok(flushes < 64, 'flushPending drains the queue');
    scene.flushPending(device, pipeline, 1e9);
  }
}

/** The reference: every final batch takes the full CPU rebuild (merge, quantize, upload). */
function forceRebuild(scene: Scene): void {
  (scene as unknown as { streamWork: { assemble: () => null } }).streamWork.assemble = () => null;
}

interface Load { scene: Scene; finalize: ReturnType<typeof recordingDevice>['work']; streamFround: number; finalizeFround: number; counters: Record<string, number> }

/** Stream like the viewer (one flush per arrival), then the time-sliced finalize. */
async function streamedLoad(options: { rebuildReference?: boolean; capture?: (snapshot: SceneSnapshot) => void; recolor?: number; mutate?: (scene: Scene, first: readonly MeshData[]) => void } = {}): Promise<Load> {
  const { device, work } = recordingDevice();
  const scene = new Scene();
  scene.setSpatialChunking({ cellSize: 32 });
  scene.setLodBuildsEnabled(true);
  scene.setQuantizedBatches(true);
  if (options.rebuildReference) forceRebuild(scene);
  if (options.capture) scene.captureNextFinalize(options.capture);
  const batches = arrivals();
  const streamFround = countFround(() => {
    for (const batch of batches) {
      scene.queueMeshes(batch);
      drain(scene, device);
    }
  }).calls;
  // A style colour resolved while streaming re-keys its mesh in place (#5358).
  if (options.recolor !== undefined) {
    const registered = scene.getMeshDataPieces(batches[0][options.recolor].expressId)![0];
    registered.color = PALETTE[(PALETTE.indexOf(registered.color as [number, number, number, number]) + 1) % PALETTE.length];
  }
  options.mutate?.(scene, batches[0]);
  Object.assign(work, { vertexWriteBytes: 0, indexWriteBytes: 0, copyBytes: 0, buffers: 0 });
  perfCounters.enable();
  const before = perfCounters.read();
  const original = Math.fround;
  let finalizeFround = 0;
  Math.fround = (x: number) => { finalizeFround++; return original(x); };
  try {
    await scene.finalizeStreamingAsync(device, pipeline, 1e9);
  } finally {
    Math.fround = original;
  }
  const counters = diffCounters(perfCounters.read(), before);
  return { scene, finalize: { ...work }, streamFround, finalizeFround, counters };
}

/** Everything a final batch draws, decoded: keys, ids, frame, bounds, indices, LOD, and each vertex's exact position, normal and lane. */
function decoded(batch: BatchedMesh): string {
  const vb = (batch.vertexBuffer as unknown as StubBuffer).bytes;
  const ib = new Uint32Array((batch.indexBuffer as unknown as StubBuffer).bytes.buffer, 0, batch.indexCount);
  let vertices = 0;
  for (const i of ib) vertices = Math.max(vertices, i + 1);
  const dv = new DataView(vb.buffer);
  const records: number[] = [];
  for (let v = 0; v < vertices; v++) {
    if (batch.quantized) {
      const { min, step } = batch.quantized;
      const o = v * 12;
      for (let axis = 0; axis < 3; axis++) records.push(Math.fround(Math.fround(min[axis]) + dv.getUint16(o + axis * 2, true) * step));
      records.push(dv.getUint16(o + 6, true), dv.getUint32(o + 8, true));
    } else {
      for (let f = 0; f < 6; f++) records.push(dv.getFloat32(v * 28 + f * 4, true));
      records.push(dv.getUint32(v * 28 + 24, true));
    }
  }
  const lod = batch.lod1IndexBuffer ? Array.from(new Uint32Array((batch.lod1IndexBuffer as unknown as StubBuffer).bytes.buffer, 0, batch.lod1IndexCount)) : null;
  return JSON.stringify({ key: batch.colorKey, color: batch.color, finish: batch.finish ?? null, ids: batch.expressIds, models: batch.modelIndices, origin: batch.origin, bounds: batch.bounds,
    quantized: !!batch.quantized, indices: Array.from(ib), lod, records });
}

/**
 * Batch-by-batch identity with a bounded failure message. `assert.deepEqual`
 * over the decoded batches would, on a mismatch, render and diff every vertex
 * of every batch: megabytes of strings per batch, enough to exhaust the host.
 */
function assertSameBatches(actual: Scene, expected: Scene): void {
  const a = actual.getBatchedMeshes(), b = expected.getBatchedMeshes();
  assert.ok(a.length === b.length, `batch count ${a.length} vs ${b.length}`);
  for (let i = 0; i < a.length; i++) {
    const x = decoded(a[i]), y = decoded(b[i]);
    if (x === y) continue;
    let at = 0;
    while (at < x.length && x[at] === y[at]) at++;
    assert.fail(`batch ${i} (${a[i].colorKey}) differs from the rebuild at char ${at}: …${x.slice(Math.max(0, at - 40), at + 40)}… vs …${y.slice(Math.max(0, at - 40), at + 40)}…`);
  }
}

/** Fragment records the stream assembly still holds, and the CPU bytes they keep alive (counts only, never the meshes). */
function retainedRuns(scene: Scene): { records: number; bytes: number } {
  const runs = (scene as unknown as { streamWork: { runs: Map<MeshData, { meshes: readonly MeshData[] }> } }).streamWork.runs;
  let bytes = 0;
  for (const run of runs.values()) for (const mesh of run.meshes) bytes += mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength;
  return { records: runs.size, bytes };
}

describe('cold finalize work after the last batch arrived', () => {
  afterEach(() => mock.restoreAll());

  it('uploads no vertex bytes the stream already uploaded, merges nothing and re-checks no topology', async () => {
    const load = await streamedLoad();
    const batches = load.scene.getBatchedMeshes();
    assert.ok(batches.length >= 10, `a multi-bucket scene (${batches.length} batches)`);
    assert.ok(batches.some((b) => b.lod1IndexBuffer), 'some batch builds LOD1, as the viewer enables it');
    assert.equal(load.finalize.vertexWriteBytes, 0, 'every final vertex buffer is a GPU copy of its fragments');
    assert.ok(load.finalize.copyBytes > 0);
    assert.equal(load.counters['render.mergeGeometry.vertices'] ?? 0, 0, 'no CPU merge of streamed vertices');
    assert.equal(load.counters['render.finalize.assembled.count'], batches.length, 'every streamed bucket is assembled');
    assert.equal(load.finalizeFround, 0, 'no f32 topology re-check in finalize');
  });

  it('checks each streamed mesh once per frame across the whole load', async () => {
    const load = await streamedLoad();
    const triangles = arrivals().flat().reduce((n, mesh) => n + mesh.indices.length / 3, 0);
    // The first arrival is scanned against its own frames before the model's
    // shared frame exists, and once more against the shared one; every later
    // mesh once. Before the stream-wide memo every mesh was scanned four times.
    assert.ok(load.streamFround + load.finalizeFround <= triangles * 9 * 1.5, `${load.streamFround + load.finalizeFround} fround calls for ${triangles} triangles`);
  });

  it('draws exactly what the full rebuild draws', async () => {
    const assembled = await streamedLoad();
    const reference = await streamedLoad({ rebuildReference: true });
    assert.equal(reference.counters['render.finalize.assembled.count'] ?? 0, 0, 'the reference took the full rebuild');
    assert.ok(reference.finalize.vertexWriteBytes > 0);
    assertSameBatches(assembled.scene, reference.scene);
  });

  it('a scene snapshot capture (the cold load\'s, #9728) still assembles, and stores exactly the bytes the GPU draws', async () => {
    let snapshot: SceneSnapshot | null = null;
    const captured = await streamedLoad({ capture: (taken) => { snapshot = taken; } });
    const batches = captured.scene.getBatchedMeshes();
    assert.equal(captured.counters['render.finalize.assembled.count'], batches.length, 'every streamed bucket is assembled while capturing');
    assert.equal(captured.finalize.vertexWriteBytes, 0, 'no CPU merge and upload for the capture');
    const taken = snapshot as SceneSnapshot | null;
    assert.ok(taken, 'the capture produced a snapshot');
    assert.ok(taken.batches.length === batches.length, `${taken.batches.length} snapshot batches for ${batches.length}`);
    const gpu = (buffer: GPUBuffer | undefined, length: number) => (buffer as unknown as StubBuffer).bytes.subarray(0, length);
    const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
    const asBytes = (view: ArrayBufferView) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (const stored of taken.batches) {
      const batch = batches.find((b) => b.colorKey === stored.key)!;
      assert.ok(batch, `a drawn batch for ${stored.key}`);
      assert.ok(same(stored.vertexData, gpu(batch.vertexBuffer, stored.vertexData.byteLength)), `${stored.key}: vertex bytes as drawn`);
      assert.ok(stored.indices.length === batch.indexCount && same(asBytes(stored.indices), gpu(batch.indexBuffer, stored.indices.byteLength)), `${stored.key}: indices as drawn`);
      assert.ok((stored.lod1Indices?.length ?? 0) === (batch.lod1IndexCount ?? 0), `${stored.key}: LOD1 presence`);
      if (stored.lod1Indices) assert.ok(same(asBytes(stored.lod1Indices), gpu(batch.lod1IndexBuffer, stored.lod1Indices.byteLength)), `${stored.key}: LOD1 as drawn`);
    }
    assertSameBatches(captured.scene, (await streamedLoad({ rebuildReference: true })).scene);
  });

  it('a recolour that keeps the bucket key but changes the entity-lane salt rebuilds that bucket', async () => {
    // colorKey rounds to 1/1000 and the salt to 1/255: both colours key `504|…`, but salt from 128 and 129.
    const before: [number, number, number, number] = [0.50388, 0.3, 0.3, 1];
    const after: [number, number, number, number] = [0.50396, 0.3, 0.3, 1];
    const recolour = (scene: Scene, first: readonly MeshData[]) => {
      const target = first.find((mesh) => mesh.color === before)!;
      scene.getMeshDataPieces(target.expressId)![0].color = after;
    };
    const seed = (load: () => Promise<Load>) => { PALETTE.push(before); return load().finally(() => PALETTE.pop()); };
    const assembled = await seed(() => streamedLoad({ mutate: recolour }));
    const reference = await seed(() => streamedLoad({ mutate: recolour, rebuildReference: true }));
    assert.ok((assembled.counters['render.finalize.rebuilt.uncovered'] ?? 0) > 0, 'the stale fragment is not assembled from');
    assertSameBatches(assembled.scene, reference.scene);
  });

  it('positions moved in place while streaming: nothing is assembled from the stale fragments', async () => {
    const move = (scene: Scene, first: readonly MeshData[]) => { scene.translateMeshesForEntity(first[0].expressId, [0.25, 0, 0]); };
    const assembled = await streamedLoad({ mutate: move });
    const reference = await streamedLoad({ mutate: move, rebuildReference: true });
    assert.equal(assembled.counters['render.finalize.assembled.count'] ?? 0, 0);
    assertSameBatches(assembled.scene, reference.scene);
  });

  it('an ephemeral (huge-file) stream keeps no stream-long topology memo alive', () => {
    const { device } = recordingDevice();
    const scene = new Scene();
    scene.setEphemeralStreamingMode(true);
    for (const batch of arrivals().slice(0, 3)) {
      scene.queueMeshes(batch);
      drain(scene, device);
    }
    assert.ok(scene.getBatchedMeshes().length > 0, 'the fragments draw');
    // A boolean, never the memo itself: a failing assertion would render every mesh it holds.
    assert.ok((scene as unknown as { streamWork: { topology: unknown } }).streamWork.topology === null,
      'no memo holds the streamed meshes (and their arrays) until the stream ends');
  });

  it('device recovery mid-stream: no fragment record outlives its fragment, and finalize still matches the rebuild', async () => {
    const recovered = async (rebuildReference: boolean) => {
      const { device } = recordingDevice();
      const scene = new Scene();
      scene.setSpatialChunking({ cellSize: 32 }); scene.setLodBuildsEnabled(true); scene.setQuantizedBatches(true);
      if (rebuildReference) forceRebuild(scene);
      const batches = arrivals();
      batches.forEach((batch, index) => {
        scene.queueMeshes(batch);
        drain(scene, device);
        // Two losses while streaming: each drops every fragment this stream drew so far.
        if (index === 3 || index === 7) {
          scene.discardGpuResourcesForRecovery();
          scene.restoreGpuResourcesAfterRecovery(device, pipeline);
        }
      });
      perfCounters.enable();
      const before = perfCounters.read();
      await scene.finalizeStreamingAsync(device, pipeline, 1e9);
      return { scene, counters: diffCounters(perfCounters.read(), before) };
    };
    const assembled = await recovered(false);
    // Only fragments drawn after the last loss can be assembled from; nothing older is copied.
    assert.ok(retainedRuns(assembled.scene).records === 0, 'the finalize swap forgets every fragment record');
    const reference = await recovered(true);
    assertSameBatches(assembled.scene, reference.scene);
    assembled.scene.releaseGeometryData();
    const retained = retainedRuns(assembled.scene);
    assert.ok(retained.records === 0 && retained.bytes === 0, `released geometry is not retained: ${retained.records} records, ${retained.bytes} bytes`);
  });

  it('device recovery right after a stream, before its finalize: the records go with the fragments', () => {
    const { device } = recordingDevice();
    const scene = new Scene();
    for (const batch of arrivals().slice(0, 4)) { scene.queueMeshes(batch); drain(scene, device); }
    assert.ok(retainedRuns(scene).records > 0, 'the stream recorded its fragments');
    scene.discardGpuResourcesForRecovery();
    const retained = retainedRuns(scene);
    assert.ok(retained.records === 0 && retained.bytes === 0, `discarded fragments keep no CPU geometry: ${retained.records} records, ${retained.bytes} bytes`);
    // The same for a reset (a new load, or a federated rebuild) mid-stream.
    scene.restoreGpuResourcesAfterRecovery(device, pipeline);
    for (const batch of arrivals().slice(4, 6)) { scene.queueMeshes(batch); drain(scene, device); }
    assert.ok(retainedRuns(scene).records > 0);
    scene.clearFlatGeometry();
    assert.ok(retainedRuns(scene).records === 0, 'a reset drops the stream records');
  });

  it('a synchronous finalize ends its assembly window: the next stream copies only from its own live fragments', async () => {
    const run = async (rebuildReference: boolean) => {
      const { device, work } = recordingDevice();
      const scene = new Scene();
      scene.setSpatialChunking({ cellSize: 32 }); scene.setLodBuildsEnabled(true); scene.setQuantizedBatches(true);
      const all = arrivals();
      for (const batch of all.slice(0, 6)) { scene.queueMeshes(batch); drain(scene, device); }
      scene.finalizeStreaming(device, pipeline); // the synchronous path
      assert.ok(retainedRuns(scene).records === 0, 'the synchronous finalize forgets its fragment records');
      if (rebuildReference) forceRebuild(scene);
      const copiedBefore = work.copyBytes;
      // A second stream into the same buckets: the stub refuses copies from destroyed (retired) fragments.
      for (const batch of all.slice(6)) { scene.queueMeshes(batch); drain(scene, device); }
      await scene.finalizeStreamingAsync(device, pipeline, 1e9);
      return { scene, copies: work.copyBytes - copiedBefore };
    };
    const assembled = await run(false);
    assert.ok(assembled.copies > 0, 'the second finalize still assembles from its own fragments');
    assertSameBatches(assembled.scene, (await run(true)).scene);
  });

  it('a synchronous finalize during a pending async one: each retires its own fragment records', async () => {
    // Review finding on #9759: the synchronous finalize replaced the pending one's
    // fragment set, which could then never retire its records (and their arrays).
    const { device } = recordingDevice();
    const scene = new Scene();
    scene.setSpatialChunking({ cellSize: 32 }); scene.setLodBuildsEnabled(true); scene.setQuantizedBatches(true);
    const all = arrivals();
    for (const batch of all.slice(0, 6)) { scene.queueMeshes(batch); drain(scene, device); }
    const pending = scene.finalizeStreamingAsync(device, pipeline, 0); // yields between chunks
    for (const batch of all.slice(6)) { scene.queueMeshes(batch); drain(scene, device); }
    scene.finalizeStreaming(device, pipeline);
    await pending;
    const retained = retainedRuns(scene);
    assert.ok(retained.records === 0 && retained.bytes === 0, `after both finalizes: ${retained.records} records, ${retained.bytes} bytes retained`);
  });

  it('a mesh re-keyed while streaming: its buckets rebuild, the rest assemble, the result still matches', async () => {
    const assembled = await streamedLoad({ recolor: 3 });
    const reference = await streamedLoad({ recolor: 3, rebuildReference: true });
    assert.ok((assembled.counters['render.finalize.rebuilt.uncovered'] ?? 0) > 0, 'the buckets the mesh left and joined rebuild');
    assert.ok((assembled.counters['render.finalize.assembled.count'] ?? 0) > 0, 'every other bucket still assembles');
    assertSameBatches(assembled.scene, reference.scene);
  });
});
