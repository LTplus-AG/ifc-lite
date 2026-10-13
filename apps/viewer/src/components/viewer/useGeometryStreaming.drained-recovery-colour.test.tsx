/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Renderer, type DeviceRecoveryResult } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { recoveryAllocationDevice } from '@/test/recovery-allocation-device';
import { installLayout } from '@/test/dom-layout';
import { applyColorUpdatesToMeshes } from '@/hooks/meshColorUpdates';

for (const finish of ['sync', 'async'] as const) it(`#6993 drained final slice recovers and ${finish} finalizes deferred colours without a fabricated tail`, { timeout: 10_000 }, async () => {
  // Four indexed pieces, including two distinct physical pieces for one ID.
  // 84 bytes each fit together initially; the replacement's 108-byte effective
  // vertex budget forces each source piece into a different physical bucket.
  const pieces: MeshData[] = [21, 21, 22, 23].map((expressId, i) => ({ expressId,
    positions: new Float32Array([i * 2, 0, 0, i * 2 + 1, 0, 0, i * 2, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
    color: [1, 0, 0, 1], modelIndex: 0 }));
  const allocation = recoveryAllocationDevice({ replacementMaxBufferSize: 120 });
  const renderer = new Renderer(allocation.canvas), restoreLayout = installLayout();
  let unsubscribe = () => {};
  let resolve!: (result: DeviceRecoveryResult) => void, reject!: (error: unknown) => void;
  const outcome = new Promise<DeviceRecoveryResult>((done, fail) => { resolve = done; reject = fail; });
  try {
    await renderer.init();
    const firstDevice = renderer.getGPUDevice(), firstPipeline = renderer.getPipeline();
    assert.ok(firstDevice); assert.ok(firstPipeline);
    const scene = renderer.getScene(); scene.queueMeshes(pieces); scene.flushPending(firstDevice, firstPipeline, 0);
    assert.equal(scene.hasStreamingFragments(), true); assert.equal(scene.hasQueuedMeshes(), false); assert.equal(scene.getBatchedMeshes().length, 1);
    assert.equal(scene.getMeshDataPieces(21)?.length, 2);
    const owned = [...(scene.getMeshDataPieces(21) ?? []), ...(scene.getMeshDataPieces(22) ?? []), ...(scene.getMeshDataPieces(23) ?? [])];
    assert.equal(owned.length, 4);
    unsubscribe = renderer.onDeviceLost(() => { void renderer.recoverDevice().then(resolve, reject); });
    allocation.loseInitialDevice('Controlled retained bucket replacement limit');
    await allocation.replacementRequested; allocation.releaseReplacement();
    assert.deepEqual(await outcome, { ok: true, omissions: [] });
    const device = renderer.getGPUDevice(), pipeline = renderer.getPipeline(); assert.ok(device); assert.ok(pipeline);
    assert.equal(device.limits.maxBufferSize, 120); assert.equal(scene.getBatchedMeshes().length, 4,
      'genuine canonical recovery repartitions the one retained bucket');
    // Actual deferred-colour producer updates the canonical retained MeshData
    // in place. Only finalize can reroute these stale colour-key partitions.
    const colours = new Map<number, [number, number, number, number]>([[21, [0, 1, 0, 1]], [22, [0, 0, 1, 1]], [23, [1, 1, 0, 1]]]);
    const retained = [...(scene.getMeshDataPieces(21) ?? []), ...(scene.getMeshDataPieces(22) ?? []), ...(scene.getMeshDataPieces(23) ?? [])];
    assert.equal(retained.length, 4);
    retained.forEach((piece, index) => assert.equal(piece, owned[index], 'actual CPU owner survives replacement repartition'));
    applyColorUpdatesToMeshes(retained, colours);
    // All real source pieces were flushed before loss. No queue entry or
    // artificial fragment may be added to make the finalizer run after recovery.
    assert.equal(scene.hasQueuedMeshes(), false);
    if (finish === 'sync') scene.finalizeStreaming(device, pipeline);
    else await scene.finalizeStreamingAsync(device, pipeline);
    const batches = scene.getBatchedMeshes();
    assert.equal(batches.reduce((sum, batch) => sum + batch.indexCount, 0), 12);
    assert.equal(scene.getMeshDataPieces(21)?.length, 2); assert.equal(scene.getMeshDataPieces(22)?.length, 1);
    const finalPieces = [...(scene.getMeshDataPieces(21) ?? []), ...(scene.getMeshDataPieces(22) ?? []), ...(scene.getMeshDataPieces(23) ?? [])];
    for (const expected of pieces) {
      const actual = finalPieces.find(piece => piece.positions === expected.positions); assert.ok(actual);
      assert.equal(actual.normals, expected.normals); assert.equal(actual.indices, expected.indices);
      assert.equal(actual.expressId, expected.expressId); assert.deepEqual(actual.origin, [0, 0, 0]);
    }
    for (const batch of batches) {
      const ids = [...batch.expressIds]; assert.equal(ids.length, 1);
    }
    await renderer.getCamera().frameBounds({ x: 0, y: 0, z: 0 }, { x: 7, y: 1, z: 0 }, 0);
    const submissions = allocation.encoding.submissions; renderer.render();
    assert.ok(allocation.encoding.submissions > submissions, 'production Renderer submits the actual finalized batches');
    console.info('6993-drained-final-slice-prerequisites', JSON.stringify({ finish, noTail: true, partitions: batches.length, indices: batches.reduce((sum, batch) => sum + batch.indexCount, 0), owner21: scene.getMeshDataPieces(21)?.length, submissions: allocation.encoding.submissions - submissions }));
    for (const batch of batches) {
      // The uniform wire layout places RGBA after the two 4x4 matrices.
      // Observe actual queue.writeBuffer bytes, not the batch metadata alone.
      assert.ok(batch.uniformBuffer, 'each submitted resident partition owns its actual uniform buffer');
      const packed = new Float32Array(allocation.bufferBytes(batch.uniformBuffer));
      assert.deepEqual([...packed.slice(32, 36)], colours.get([...batch.expressIds][0]),
        'submitted draw uniform packs the deferred RGBA for each actual partition');
      assert.deepEqual(batch.color, colours.get([...batch.expressIds][0]), 'actual finalized partition uses current authored colour');
    }
    assert.equal(scene.hasStreamingFragments(), false); assert.equal(scene.hasQueuedMeshes(), false);
  } finally {
    unsubscribe(); allocation.releaseReplacement(); allocation.releaseReplacementPipelines();
    renderer.destroy(); allocation.restore(); restoreLayout();
  }
});

it('#6993 a second loss before no-tail finalization retains source ownership and refuses a Scene.clear during replacement', { timeout: 10_000 }, async () => {
  const piece: MeshData = { expressId: 31, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]), color: [1, 0, 0, 1], modelIndex: 0 };
  const allocation = recoveryAllocationDevice({ extraRecoveryAttempt: true });
  let loseReplacement!: (info: Pick<GPUDeviceLostInfo, 'reason' | 'message'>) => void;
  Object.defineProperty(allocation.devices[1], 'lost', { value: new Promise<Pick<GPUDeviceLostInfo, 'reason' | 'message'>>(done => { loseReplacement = done; }) });
  let requestedThird!: () => void, releaseThird!: () => void;
  const thirdRequested = new Promise<void>(done => { requestedThird = done; });
  const thirdReleased = new Promise<void>(done => { releaseThird = done; });
  const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  // Scheduling only: each actual allocation-boundary device is still supplied
  // by the original helper; the third request waits before Renderer publishes it.
  navigator.gpu.requestAdapter = async options => {
    const adapter = await requestAdapter(options); if (!adapter) return null;
    const requestDevice = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async descriptor => {
      const device = await requestDevice(descriptor);
      if (device === allocation.devices[2]) { requestedThird(); await thirdReleased; }
      return device;
    };
    return adapter;
  };
  const renderer = new Renderer(allocation.canvas), restoreLayout = installLayout();
  const attempts: Array<Promise<DeviceRecoveryResult>> = [];
  let unsubscribe = () => {};
  try {
    await renderer.init();
    const initialDevice = renderer.getGPUDevice(), initialPipeline = renderer.getPipeline(); assert.ok(initialDevice); assert.ok(initialPipeline);
    const scene = renderer.getScene(); scene.queueMeshes([piece]); scene.flushPending(initialDevice, initialPipeline, 0);
    assert.equal(scene.hasQueuedMeshes(), false); assert.equal(scene.getBatchedMeshes().length, 1);
    unsubscribe = renderer.onDeviceLost(() => { attempts.push(renderer.recoverDevice()); });
    allocation.loseInitialDevice('Controlled first drained-slice loss');
    await allocation.replacementRequested; allocation.releaseReplacement();
    assert.equal(attempts.length, 1); const firstRecovery = await attempts[0]; assert.deepEqual(firstRecovery, { ok: true, omissions: [] });
    assert.equal(scene.hasQueuedMeshes(), false);
    const retainedIndices = scene.getBatchedMeshes().reduce((sum, batch) => sum + batch.indexCount, 0); assert.equal(retainedIndices, 3);
    assert.equal(scene.getMeshDataPieces(31)?.length, 1);
    // No new queue entry or GPU fragment is introduced between the two losses.
    loseReplacement({ reason: 'unknown', message: 'Controlled second loss with retained finalization owner' });
    await thirdRequested; assert.equal(allocation.deviceRequestCount(), 3); assert.equal(attempts.length, 2);
    assert.equal(renderer.getGPUDevice(), null);
    scene.clear();
    releaseThird();
    const secondRecovery = await attempts[1];
    console.info('6993-second-loss-prerequisites', JSON.stringify({ firstRecovery, retainedIndices, requests: allocation.deviceRequestCount(), attempts: attempts.length, secondRecovery }));
    assert.deepEqual(secondRecovery, { ok: false, reason: 'scene-not-settled' },
      'pending retained keys require the same source lease even after old GPU fragments have been retired');
    assert.equal(renderer.getGPUDevice(), null); assert.equal(renderer.isReady(), false);
    assert.equal(scene.getMeshDataPieces(31), undefined); assert.equal(scene.getBatchedMeshes().length, 0);
    assert.equal(scene.hasQueuedMeshes(), false);
  } finally {
    unsubscribe(); releaseThird(); allocation.releaseReplacement(); allocation.releaseReplacementPipelines();
    renderer.destroy(); allocation.restore(); restoreLayout();
  }
});

for (const mutation of ['bytes', 'reference'] as const) it(`#6993 held recovery observes current CPU index ${mutation} rather than resurrecting a stale GPU fragment`, { timeout: 10_000 }, async () => {
  const piece: MeshData = { expressId: 41, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]), color: [1, 0, 0, 1], modelIndex: 0 };
  const allocation = recoveryAllocationDevice(), renderer = new Renderer(allocation.canvas), restoreLayout = installLayout();
  let unsubscribe = () => {};
  let resolve!: (result: DeviceRecoveryResult) => void, reject!: (error: unknown) => void;
  const outcome = new Promise<DeviceRecoveryResult>((done, fail) => { resolve = done; reject = fail; });
  try {
    await renderer.init();
    const initialDevice = renderer.getGPUDevice(), initialPipeline = renderer.getPipeline(); assert.ok(initialDevice); assert.ok(initialPipeline);
    const scene = renderer.getScene(); scene.queueMeshes([piece]); scene.flushPending(initialDevice, initialPipeline, 0);
    assert.equal(scene.hasQueuedMeshes(), false);
    const originalBatch = scene.getBatchedMeshes()[0]; assert.ok(originalBatch);
    assert.deepEqual([...new Uint32Array(allocation.bufferBytes(originalBatch.indexBuffer))], [0, 1, 2]);
    const owned = scene.getMeshDataPieces(41)?.[0]; assert.ok(owned);
    unsubscribe = renderer.onDeviceLost(() => { void renderer.recoverDevice().then(resolve, reject); });
    allocation.loseInitialDevice('Controlled current-CPU index boundary');
    await allocation.replacementRequested;
    if (mutation === 'bytes') owned.indices.set([2, 1, 0]);
    else owned.indices = new Uint32Array([2, 1, 0]);
    allocation.releaseReplacement();
    const result = await outcome;
    if (mutation === 'reference') {
      assert.deepEqual(result, { ok: false, reason: 'scene-not-settled' });
      assert.equal(renderer.getGPUDevice(), null); assert.equal(renderer.isReady(), false);
    } else {
      assert.deepEqual(result, { ok: true, omissions: [] });
      const batch = scene.getBatchedMeshes()[0]; assert.ok(batch);
      assert.equal(batch.indexCount, 3); assert.equal(scene.getMeshDataPieces(41)?.[0], owned);
      assert.deepEqual([...owned.indices], [2, 1, 0]);
      assert.deepEqual([...new Uint32Array(allocation.bufferBytes(batch.indexBuffer))], [2, 1, 0],
        'restored GPU index bytes come from the current CPU source, not the retired fragment');
    }
  } finally {
    unsubscribe(); allocation.releaseReplacement(); allocation.releaseReplacementPipelines();
    renderer.destroy(); allocation.restore(); restoreLayout();
  }
});
