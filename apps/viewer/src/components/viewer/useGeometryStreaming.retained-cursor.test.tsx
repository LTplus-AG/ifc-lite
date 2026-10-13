/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Renderer, type DeviceRecoveryResult } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { recoveryAllocationDevice } from '@/test/recovery-allocation-device';

it('#6993 actual nonzero queue cursor and append-only tail resume exactly once after staged replacement', { timeout: 10_000 }, async () => {
  // Stated invariant: 1,025 distinct indexed triangles exceed one canonical
  // 512-mesh flush slice. Repeated source piece references are legitimate queue
  // multiplicity; five more are appended while replacement pipelines await.
  const meshes: MeshData[] = Array.from({ length: 1025 }, (_, i) => ({ expressId: i + 1,
    positions: new Float32Array([i, 0, 0, i + 1, 0, 0, i, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
    color: [0.2, 0.4, 0.6, 1], modelIndex: 0 }));
  const tail = [meshes[0], meshes[0], meshes[1], meshes[1], meshes[1]];
  const allocation = recoveryAllocationDevice(), renderer = new Renderer(allocation.canvas);
  let unsubscribe = () => { /* Installed after actual init. */ };
  let resolve!: (value: DeviceRecoveryResult) => void, reject!: (error: unknown) => void;
  const outcome = new Promise<DeviceRecoveryResult>((done, fail) => { resolve = done; reject = fail; });
  try {
    await renderer.init(); await renderer.enableQuantizedBatches();
    const device = renderer.getGPUDevice(), pipeline = renderer.getPipeline(); assert.ok(device); assert.ok(pipeline);
    const scene = renderer.getScene(); scene.queueMeshes(meshes); scene.flushPending(device, pipeline, 0);
    const uploaded = scene.getAllMeshDataExpressIds().flatMap(id => scene.getMeshDataPieces(id) ?? []);
    assert.equal(uploaded.length, 512, 'actual canonical first flush advances a nonzero cursor without emptying the queue');
    assert.equal(scene.hasQueuedMeshes(), true); assert.equal(scene.hasStreamingFragments(), true);
    unsubscribe = renderer.onDeviceLost(() => { void renderer.recoverDevice().then(resolve, reject); });
    allocation.holdReplacementPipelines(); allocation.loseInitialDevice('Controlled cursor-prefix loss');
    assert.equal(await Promise.race([allocation.replacementRequested.then(() => 'replacement'), outcome]), 'replacement');
    renderer.render(); assert.equal(renderer.getGPUDevice(), null);
    assert.equal(scene.getAllMeshDataExpressIds().length, 512, 'frame while request is held cannot consume the suffix');
    allocation.releaseReplacement(); await allocation.pipelineRequested;
    scene.queueMeshes(tail); renderer.render(); assert.equal(renderer.getGPUDevice(), null);
    assert.equal(scene.getAllMeshDataExpressIds().length, 512, 'frame while pipeline is held cannot consume the newly appended tail');
    allocation.releaseReplacementPipelines(); assert.deepEqual(await outcome, { ok: true, omissions: [] });
    const replacement = renderer.getGPUDevice(), restoredPipeline = renderer.getPipeline(); assert.ok(replacement); assert.ok(restoredPipeline);
    assert.equal(scene.getAllMeshDataExpressIds().length, 512, 'commit restores uploaded prefix and leaves cursor suffix pending');
    for (let i = 0; scene.hasQueuedMeshes() && i < 8; i++) scene.flushPending(replacement, restoredPipeline, 0);
    assert.equal(scene.hasQueuedMeshes(), false); await scene.finalizeStreamingAsync(replacement, restoredPipeline);
    const pieces = scene.getAllMeshDataExpressIds().flatMap(id => scene.getMeshDataPieces(id) ?? []);
    assert.equal(pieces.length, meshes.length + tail.length, 'all source rows and repeated tail occurrences remain');
    assert.equal(scene.getMeshDataPieces(1)?.length, 3); assert.equal(scene.getMeshDataPieces(2)?.length, 4);
    assert.equal(scene.getBatchedMeshes().reduce((sum, batch) => sum + batch.indexCount, 0), (meshes.length + tail.length) * 3,
      'pending cursor is neither replayed nor skipped during replacement');
    assert.ok(scene.getBatchedMeshes().every(batch => allocation.live.has(batch.vertexBuffer)));
  } finally { unsubscribe(); renderer.destroy(); allocation.restore(); }
});
