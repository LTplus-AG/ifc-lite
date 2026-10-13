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

it('#6993 smaller replacement partitions retain deferred streamed colours and repeated owner pieces through finalization', { timeout: 10_000 }, async () => {
  // Three distinct indexed pieces, including two real occurrences for one ID.
  // 84 bytes each fit together initially; the replacement's 108-byte effective
  // vertex budget forces each source piece into a different physical bucket.
  const pieces: MeshData[] = [21, 21, 22].map((expressId, i) => ({ expressId,
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
    assert.equal(scene.hasStreamingFragments(), true); assert.equal(scene.getBatchedMeshes().length, 1);
    assert.equal(scene.getMeshDataPieces(21)?.length, 2);
    const owned = [...(scene.getMeshDataPieces(21) ?? []), ...(scene.getMeshDataPieces(22) ?? [])];
    assert.equal(owned.length, 3);
    unsubscribe = renderer.onDeviceLost(() => { void renderer.recoverDevice().then(resolve, reject); });
    allocation.loseInitialDevice('Controlled retained bucket replacement limit');
    await allocation.replacementRequested; allocation.releaseReplacement();
    assert.deepEqual(await outcome, { ok: true, omissions: [] });
    const device = renderer.getGPUDevice(), pipeline = renderer.getPipeline(); assert.ok(device); assert.ok(pipeline);
    assert.equal(device.limits.maxBufferSize, 120); assert.equal(scene.getBatchedMeshes().length, 3,
      'genuine canonical recovery repartitions the one retained bucket');
    // Actual deferred-colour producer updates the canonical retained MeshData
    // in place. Only finalize can reroute these stale colour-key partitions.
    const colours = new Map<number, [number, number, number, number]>([[21, [0, 1, 0, 1]], [22, [0, 0, 1, 1]]]);
    const retained = [...(scene.getMeshDataPieces(21) ?? []), ...(scene.getMeshDataPieces(22) ?? [])];
    assert.equal(retained.length, 3);
    retained.forEach((piece, index) => assert.equal(piece, owned[index], 'actual CPU owner survives replacement repartition'));
    applyColorUpdatesToMeshes(retained, colours);
    // Recovery retired the old GPU fragments. A normal subsequent stream
    // slice supplies the fragment that triggers the canonical finalizer.
    const tail: MeshData = { ...pieces[0], color: [0, 1, 0, 1], positions: new Float32Array([6, 0, 0, 7, 0, 0, 6, 1, 0]) };
    scene.queueMeshes([tail]); scene.flushPending(device, pipeline, 0);
    assert.equal(scene.hasStreamingFragments(), true);
    const tailRow = scene.getMeshDataPieces(21)?.find(piece => piece.positions === tail.positions); assert.ok(tailRow);
    await scene.finalizeStreamingAsync(device, pipeline);
    const batches = scene.getBatchedMeshes();
    assert.equal(batches.reduce((sum, batch) => sum + batch.indexCount, 0), 12);
    assert.equal(scene.getMeshDataPieces(21)?.length, 3); assert.equal(scene.getMeshDataPieces(22)?.length, 1);
    assert.ok(scene.getMeshDataPieces(21)?.includes(tailRow), 'canonical tail owner survives finalization');
    const finalPieces = [...(scene.getMeshDataPieces(21) ?? []), ...(scene.getMeshDataPieces(22) ?? [])];
    for (const expected of [...pieces, tail]) {
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
    console.info('6993-smaller-limit-prerequisites', JSON.stringify({ partitions: batches.length, indices: batches.reduce((sum, batch) => sum + batch.indexCount, 0), owner21: scene.getMeshDataPieces(21)?.length, submissions: allocation.encoding.submissions - submissions }));
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
