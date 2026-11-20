/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `replayReleasedGeometry` (#10264): released flat geometry streams back into a
 * scene batch by batch, ends released with no CPU pieces kept, keeps each
 * entity's bounds across batches, and stops cleanly when cancelled or
 * superseded (never leaves an ephemeral pass open).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import type { RenderPipeline } from './pipeline.js';
import type { Renderer } from './renderer.js';
import { replayReleasedGeometry } from './released-geometry-replay.js';

Object.assign(globalThis, { GPUBufferUsage: { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 } });

function device(): GPUDevice {
  return {
    limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28 },
    createBuffer: ({ size, usage }: GPUBufferDescriptor) => ({ size, usage, bytes: new Uint8Array(size), destroy() {} }),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({ copyBufferToBuffer() {}, finish: () => ({}) }),
    queue: { submit() {}, writeBuffer() {} },
  } as unknown as GPUDevice;
}
const pipeline = { getUniformBufferSize: () => 256, getBindGroupLayout: () => ({}) } as unknown as RenderPipeline;

/** A triangle of entity `id` spanning x..x+1 at height z. */
function tri(id: number, x: number, z: number): MeshData {
  return { expressId: id, positions: Float32Array.from([x, 0, z, x + 1, 0, z, x, 1, z]), normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: Uint32Array.from([0, 1, 2]), color: [0.5, 0.5, 0.5, 1] };
}

function host(scene: Scene, gpu: GPUDevice | null) {
  let renders = 0;
  const renderer = { getScene: () => scene, getGPUDevice: () => gpu, getPipeline: () => pipeline, requestRender: () => { renders++; } };
  return { renderer: renderer as unknown as Pick<Renderer, 'getScene' | 'getGPUDevice' | 'getPipeline' | 'requestRender'>, renders: () => renders };
}

async function* batches(...lists: MeshData[][]): AsyncGenerator<readonly MeshData[]> { for (const list of lists) yield list; }

describe('replayReleasedGeometry', () => {
  it('streams batches back, keeps no CPU pieces, and unions entity bounds across batches', async () => {
    const scene = new Scene();
    const gpu = device();
    // Entity 1's pieces arrive in two different batches.
    const result = await replayReleasedGeometry(host(scene, gpu).renderer, batches([tri(1, 0, 0), tri(2, 5, 0)], [tri(1, 2, 3)]));
    assert.deepEqual(result, { status: 'complete', batches: 2, meshes: 3 });
    assert.equal(scene.isGeometryDataReleased(), true, 'finishes released');
    assert.equal(scene.isEphemeralStreaming(), false);
    assert.equal(scene.getMeshDataPieces(1), undefined, 'no CPU pieces retained');
    assert.ok(scene.getBatchedMeshes().length > 0, 'drawn from GPU batches');
    const box = scene.getEntityBoundingBox(1)!;
    assert.deepEqual([box.min.x, box.min.z, box.max.x, box.max.z], [0, 0, 3, 3], 'bounds span both batches');
    assert.ok(scene.getEntityBoundingBox(2), 'every replayed entity keeps a box');
  });

  it('a superseded or cancelled replay closes the pass, says it is partial and keeps nothing it uploaded', async () => {
    let current = true;
    const scene = new Scene();
    async function* twoThenStale(): AsyncGenerator<readonly MeshData[]> {
      yield [tri(1, 0, 0)];
      current = false; // a newer reload or device change arrives mid-replay
      yield [tri(2, 5, 0)];
    }
    const superseded = await replayReleasedGeometry(host(scene, device()).renderer, twoThenStale(), { isCurrent: () => current });
    assert.deepEqual(superseded, { status: 'superseded', batches: 1, meshes: 1 });
    assert.equal(scene.isEphemeralStreaming(), false, 'never left open');
    assert.equal(scene.getEntityBoundingBox(2), null, 'nothing after the fence');
    assert.equal(scene.getBatchedMeshes().length, 0, 'and batch 1 is rolled back: a retry starts clean');

    const controller = new AbortController();
    controller.abort();
    const cancelled = await replayReleasedGeometry(host(new Scene(), device()).renderer, batches([tri(1, 0, 0)]), { signal: controller.signal });
    assert.equal(cancelled.status, 'cancelled');
  });

  it('#10903 a device swap mid-replay supersedes it before the next batch is ever uploaded', async () => {
    const scene = new Scene();
    const uploaded: number[][] = [];
    const append = scene.appendToBatches.bind(scene);
    scene.appendToBatches = (batch, ...rest) => { uploaded.push(batch.map((m) => m.expressId)); return append(batch, ...rest); };
    let gpu: GPUDevice = device();
    const renderer = { getScene: () => scene, getGPUDevice: () => gpu, getPipeline: () => pipeline, requestRender() {} } as unknown as Pick<Renderer, 'getScene' | 'getGPUDevice' | 'getPipeline' | 'requestRender'>;
    async function* swap(): AsyncGenerator<readonly MeshData[]> { yield [tri(1, 0, 0)]; gpu = device(); yield [tri(2, 0, 0)]; }
    assert.equal((await replayReleasedGeometry(renderer, swap())).status, 'superseded');
    assert.deepEqual(uploaded, [[1]], 'batch 2 never reached the stale device (the in-loop fence, not only the final one)');
  });

  for (const outcome of ['cancel', 'failure'] as const) {
    it(`#10903 a ${outcome} after batch 1 leaves no entity or placement bounds behind, and the retry's bounds are exact`, async () => {
      const scene = new Scene();
      const gpu = device();
      const controller = new AbortController();
      async function* source(fail: boolean): AsyncGenerator<readonly MeshData[]> {
        yield [{ ...tri(7, 50, 0), modelIndex: 0 }];
        if (fail) { if (outcome === 'cancel') controller.abort(); else throw new Error('read failed'); }
        yield [tri(8, 0, 0)];
      }
      const first = replayReleasedGeometry(host(scene, gpu).renderer, source(true), { signal: controller.signal });
      if (outcome === 'failure') await assert.rejects(first); else assert.equal((await first).status, 'cancelled');
      assert.equal(scene.getEntityBoundingBox(7), null, 'no stale entity box survives the rollback');
      const released = (scene as unknown as { modelTranslations: { releasedEntities: Map<number, unknown> } }).modelTranslations.releasedEntities;
      assert.equal(released.has(7), false, 'nor a stale placement group');
      assert.equal((await replayReleasedGeometry(host(scene, gpu).renderer, source(false))).status, 'complete');
      const box = scene.getEntityBoundingBox(7)!;
      assert.deepEqual([box.min.x, box.max.x], [50, 51], 'the retry unions from a clean start: exactly its own extent');
    });
  }

  it('#10903 a replay that uploads batch 1 then fails keeps nothing; its retry draws every batch exactly once', async () => {
    const scene = new Scene();
    const gpu = device();
    let fail = true;
    async function* source(): AsyncGenerator<readonly MeshData[]> {
      yield [tri(1, 0, 0)];
      if (fail) throw new Error('backing read failed at batch 2');
      yield [tri(2, 5, 0)];
    }
    await assert.rejects(replayReleasedGeometry(host(scene, gpu).renderer, source()), /batch 2/);
    assert.equal(scene.getBatchedMeshes().length, 0, 'the partial upload is rolled back');
    fail = false;
    assert.equal((await replayReleasedGeometry(host(scene, gpu).renderer, source())).status, 'complete');
    const reference = new Scene();
    await replayReleasedGeometry(host(reference, device()).renderer, batches([tri(1, 0, 0)], [tri(2, 5, 0)]));
    assert.equal(scene.getBatchedMeshes().length, reference.getBatchedMeshes().length, 'the same batches as one clean replay, never batch 1 twice');
    const drawn = scene.getBatchedMeshes().flatMap((b) => [...(b as unknown as { expressIds: number[] }).expressIds]).sort();
    assert.deepEqual(drawn, [1, 2]);
  });

  for (const change of ['abort', 'device', 'owner'] as const) {
    it(`#10903 a ${change} change after the final yielded batch prevents a complete result`, async () => {
      const scene = new Scene();
      let gpu: GPUDevice = device();
      let current = true;
      const controller = new AbortController();
      const renderer = { getScene: () => scene, getGPUDevice: () => gpu,
        getPipeline: () => pipeline, requestRender() {} };
      async function* source(): AsyncGenerator<readonly MeshData[]> {
        yield [tri(1, 0, 0)];
        // The consumer is awaiting next(); there is no second batch at which
        // its in-loop fence can notice the change.
        await Promise.resolve();
        if (change === 'abort') controller.abort();
        else if (change === 'device') gpu = device();
        else current = false;
      }
      const result = await replayReleasedGeometry(renderer, source(), {
        signal: controller.signal, isCurrent: () => current,
      });
      assert.deepEqual(result, { status: change === 'abort' ? 'cancelled' : 'superseded', batches: 1, meshes: 1 });
      assert.equal(scene.isEphemeralStreaming(), false, 'a partial final result still closes the pass');
      assert.equal(scene.getBatchedMeshes().length, 0, 'and keeps none of what it uploaded');
    });
  }

  it('an error mid-stream still closes the pass before rethrowing', async () => {
    const scene = new Scene();
    async function* broken(): AsyncGenerator<readonly MeshData[]> { yield [tri(1, 0, 0)]; throw new Error('backing read failed'); }
    await assert.rejects(replayReleasedGeometry(host(scene, device()).renderer, broken()), /backing read failed/);
    assert.equal(scene.isEphemeralStreaming(), false);
    assert.equal(scene.getBatchedMeshes().length, 0, 'and rolls back what it uploaded');
  });

  it('reports a missing device instead of pretending to replay', async () => {
    assert.deepEqual(await replayReleasedGeometry(host(new Scene(), null).renderer, batches([tri(1, 0, 0)])),
      { status: 'unavailable', reason: 'no-device' });
  });
  const releasedOf = (scene: Scene) => (scene as unknown as { modelTranslations: { releasedEntities: Map<number, Map<number, unknown>> } }).modelTranslations.releasedEntities;
  const drawnIds = (scene: Scene) => scene.getBatchedMeshes().flatMap((b) => [...(b as unknown as { expressIds: number[] }).expressIds]).sort();

  it('#10903 a superseded replay rolls back only what it owns: a successor that wrote meanwhile keeps its fragment and boxes', async () => {
    const scene = new Scene();
    const gpu = device();
    let current = true;
    async function* stalled(): AsyncGenerator<readonly MeshData[]> {
      yield [{ ...tri(1, 0, 0), modelIndex: 0 }];
      // While this replay waits on its next read, a successor reshapes the scene: it draws
      // entity 9 and widens entity 1's boxes, then this replay is superseded.
      scene.appendToBatches([{ ...tri(9, 20, 0), modelIndex: 0 }, { ...tri(1, -10, 0), modelIndex: 0 }], gpu, pipeline, true);
      current = false;
      yield [tri(2, 5, 0)];
    }
    const result = await replayReleasedGeometry(host(scene, gpu).renderer, stalled(), { isCurrent: () => current });
    assert.equal(result.status, 'superseded');
    assert.deepEqual(drawnIds(scene), [1, 9], "the successor's fragment survives; only this replay's own is destroyed");
    assert.ok(scene.getEntityBoundingBox(9), "the successor's entity box survives");
    const box = scene.getEntityBoundingBox(1)!;
    assert.deepEqual([box.min.x, box.max.x], [-10, -9], "entity 1's box holds only the successor's extent: the superseded replay's staged [0, 1] never reached the scene");
    assert.ok(releasedOf(scene).get(9)?.has(0), "the successor's placement group survives");
  });

  it('#10903 a clear() and a complete successor replay before the stale one resumes: the stale rollback touches nothing', async () => {
    const scene = new Scene();
    const gpu = device();
    let resume!: () => void;
    const gate = new Promise<void>((done) => { resume = done; });
    async function* stale(): AsyncGenerator<readonly MeshData[]> { yield [tri(1, 0, 0)]; await gate; yield [tri(2, 5, 0)]; }
    let current = true;
    const first = replayReleasedGeometry(host(scene, gpu).renderer, stale(), { isCurrent: () => current });
    await new Promise((done) => setTimeout(done, 0));
    current = false;
    scene.clear(); // a reload resets the scene, then its successor replays the new content
    const successor = replayReleasedGeometry(host(scene, gpu).renderer, batches([tri(1, 30, 0)])); // waits for the stale pass
    resume();
    assert.equal((await first).status, 'superseded');
    assert.equal((await successor).status, 'complete');
    assert.deepEqual(drawnIds(scene), [1], "the successor's draw stays");
    const box = scene.getEntityBoundingBox(1)!;
    assert.deepEqual([box.min.x, box.max.x], [30, 31], "the successor's box, never the stale replay's prior state");
    assert.equal(scene.isGeometryDataReleased(), true);
  });

  it('#10903 a finalize that rejects after every batch uploaded rolls the replay back and closes the pass', async () => {
    const scene = new Scene();
    const gpu = device();
    scene.finalizeStreamingAsync = () => Promise.reject(new Error('finalize failed'));
    await assert.rejects(replayReleasedGeometry(host(scene, gpu).renderer, batches([{ ...tri(4, 0, 0), modelIndex: 0 }])), /finalize failed/);
    assert.equal(scene.getBatchedMeshes().length, 0, 'no partial upload survives a failed finalize');
    assert.equal(scene.getEntityBoundingBox(4), null, 'nor its entity box');
    assert.equal(releasedOf(scene).has(4), false, 'nor its placement group');
    assert.equal(scene.isEphemeralStreaming(), false, 'the pass is closed');
  });
  it('#10903 interleaved replays A [0,1] and B [-10,-9] of one entity: A never finalizes B\'s pass, and only B\'s bounds survive', async () => {
    const scene = new Scene();
    const gpu = device();
    let resumeA!: () => void, resumeB!: () => void;
    const gateA = new Promise<void>((done) => { resumeA = done; }), gateB = new Promise<void>((done) => { resumeB = done; });
    let aCurrent = true, bAwaiting = false;
    async function* a(): AsyncGenerator<readonly MeshData[]> { yield [{ ...tri(1, 0, 0), modelIndex: 0 }]; await gateA; yield [tri(2, 5, 0)]; }
    async function* b(): AsyncGenerator<readonly MeshData[]> { yield [{ ...tri(1, -10, 0), modelIndex: 0 }]; bAwaiting = true; await gateB; }
    const first = replayReleasedGeometry(host(scene, gpu).renderer, a(), { isCurrent: () => aCurrent });
    await new Promise((done) => setTimeout(done, 0)); // A has uploaded [0,1] and waits on its next read
    const second = replayReleasedGeometry(host(scene, gpu).renderer, b());
    aCurrent = false; // B's reload supersedes A
    resumeA();
    assert.equal((await first).status, 'superseded');
    while (!bAwaiting) await new Promise((done) => setTimeout(done, 0));
    assert.equal(scene.isEphemeralStreaming(), true, "A's close never finalized B's pass while B awaits its read");
    resumeB();
    assert.equal((await second).status, 'complete');
    const box = scene.getEntityBoundingBox(1)!;
    assert.deepEqual([box.min.x, box.max.x], [-10, -9], "only B's extent: A's never contaminated it");
    const group = releasedOf(scene).get(1)?.get(0) as { min: { x: number }; max: { x: number } } | undefined;
    assert.deepEqual([group?.min.x, group?.max.x], [-10, -9], "and the placement group is B's alone");
    assert.deepEqual(drawnIds(scene), [1], "only B's fragment is drawn");
  });
});
