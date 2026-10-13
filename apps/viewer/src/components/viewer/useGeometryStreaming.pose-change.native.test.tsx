/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { MeshData } from '@ifc-lite/geometry';
import { sectionIndexedBounds } from '@/test/section-native-geometry';
import { retainedStreamFixture } from '@/test/retained-stream-recovery';

it('#6993 public native model yaw during pipeline wait refuses the old pose and a stable retry restores the current pose', { timeout: 30_000 }, async t => {
  const f = await retainedStreamFixture(t, 1, true); if (!f) return;
  try {
    const angle = Math.PI / 3, pivot: [number, number, number] = [0, 0, 0];
    // The uninterrupted native Scene provides a real placed population. Extrema
    // are independently traversed indexed corners, never production AABBs.
    assert.equal(f.oracleScene.setModelRotation(0, angle, pivot), true);
    const rotated = sectionIndexedBounds(f.oracleScene, f.ids);
    const rotatedInstances = f.ids.flatMap(id => f.oracleScene.getInstancedMeshDataPieces(id) ?? []);
    assert.equal(rotatedInstances.length, f.expectedInstances.length);
    let changedCorners = 0, visited = 0;
    for (let i = 0; i < rotatedInstances.length; i++) {
      const placed: MeshData = rotatedInstances[i], original: MeshData = f.expectedInstances[i];
      assert.deepEqual(placed.indices, original.indices);
      for (const index of placed.indices) {
        assert.ok(++visited <= 2_000_000, 'native indexed pose witness stays bounded');
        for (let axis = 0; axis < 3; axis++) if (
          placed.positions[index * 3 + axis] + (placed.origin?.[axis] ?? 0) !==
          original.positions[index * 3 + axis] + (original.origin?.[axis] ?? 0)) changedCorners++;
      }
    }
    assert.ok(changedCorners > 0, 'actual native IFNS yaw moves indexed corners even when flat geometry dominates whole-scene bounds');
    await f.begin(); await f.enterPipelines(); await f.tickWhileHeld();
    const before = f.population().instances;
    assert.equal(f.scene.setModelRotation(0, angle, pivot), true, 'actual public pose setter accepts the new yaw');
    assert.equal(f.scene.setModelRotation(0, angle, pivot), false,
      'the same public yaw and pivot is now an idempotent no-op');
    assert.deepEqual(f.population().instances, before,
      'the canonical setter cannot rewrite IFNS CPU matrices through absent GPU templates at this boundary');
    f.allocation.releaseReplacementPipelines();
    const refused = await f.result;
    console.info('6993-native-pose-await-proof', JSON.stringify({ sourceSHA: f.sourceSHA, instances: before.length,
      observed: refused, deviceRequests: f.allocation.deviceRequestCount() }));
    assert.deepEqual(refused, { ok: false, reason: 'scene-not-settled' },
      'actual native current yaw must invalidate the old pending recovery lease');
    assert.equal(f.renderer.isReady(), false); assert.equal(f.renderer.getGPUDevice(), null);
    assert.equal(f.scene.hasQueuedMeshes(), true); assert.equal(f.attempts.length, 1,
      'source-pose refusal does not silently retry a changed load');
    // This is a deliberate subsequent call after the pose becomes stable, not
    // a substituted recovery result or second source ingestion.
    const restored = await f.renderer.recoverDevice();
    assert.deepEqual(restored, { ok: true, omissions: [] });
    await f.settleManualRecovery();
    f.assertCurrentOracle();
    assert.deepEqual(sectionIndexedBounds(f.scene, f.ids), rotated,
      'actual restored IFNS matrices use the requested current yaw, not the pre-loss pose');
    assert.equal(f.allocation.deviceRequestCount(), 3);
  } finally { f.dispose(); }
});
