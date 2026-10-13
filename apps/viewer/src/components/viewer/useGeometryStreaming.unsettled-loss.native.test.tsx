/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { retainedStreamFixture } from '@/test/retained-stream-recovery';

for (const models of [1, 2] as const) it(`#6993 real native ${models}-model retained stream restores before pending cursor resumes`, { timeout: 30_000 }, async t => {
  const f = await retainedStreamFixture(t, models); if (!f) return;
  try {
    await f.begin(); await f.tickWhileHeld();
    await f.enterPipelines(); await f.tickWhileHeld();
    await f.complete();
    assert.equal(f.allocation.deviceRequestCount(), 2);
    assert.deepEqual(f.attempts, [{ ok: true, omissions: [] }]);
    console.info('6993-retained-native-positive', JSON.stringify({ models, flat: f.expectedFlat.length, instances: f.expectedInstances.length,
      sourceSHA: f.sourceSHA, runtimeSHA: f.runtimeSHA, attempts: f.attempts }));
  } finally { f.dispose(); }
});

it('#6993 later real vertex allocation failure disposes partial recovery and retries the original native suffix', { timeout: 30_000 }, async t => {
  const f = await retainedStreamFixture(t, 1, true); if (!f) return;
  try {
    await f.begin(); await f.enterPipelines(); await f.tickWhileHeld();
    f.allocation.failReplacementVertexAllocationAfter(1);
    await f.complete();
    assert.equal(f.attempts.length, 2); assert.equal(f.attempts[0].ok, false);
    const failed = f.attempts[0]; assert.ok(!failed.ok); assert.equal(failed.reason, 'scene-restore-failed');
    assert.ok(failed.error instanceof DOMException); assert.equal(failed.error.name, 'OperationError');
    assert.equal(f.allocation.stagedVertices.length, 1, 'one actual staged vertex owner exists before later allocation refusal');
    assert.ok(f.allocation.stagedVertices.every(buffer => !f.allocation.live.has(buffer)), 'the failed attempt leaves no staged vertex owner live');
    assert.equal(f.allocation.deviceRequestCount(), 3); f.assertComplete();
  } finally { f.dispose(); }
});

for (const stage of ['request', 'pipeline'] as const) it(`#6993 actual Scene.clear during ${stage} wait cannot resurrect an old native source`, { timeout: 30_000 }, async t => {
  const f = await retainedStreamFixture(t, 1); if (!f) return;
  try {
    await f.begin(); if (stage === 'pipeline') await f.enterPipelines();
    f.scene.clear();
    // A different load now owns this actual queue. No editor or private fields.
    const replacement = { ...f.flat[0], expressId: 987654 };
    f.scene.queueMeshes([replacement]);
    f.allocation.releaseReplacement(); f.allocation.releaseReplacementPipelines();
    assert.deepEqual(await f.result, { ok: false, reason: 'scene-not-settled' });
    assert.equal(f.renderer.isReady(), false); assert.equal(f.renderer.getGPUDevice(), null);
    assert.equal(f.scene.hasQueuedMeshes(), true, 'new-load pending work survives refusal');
    assert.equal(f.scene.getBatchedMeshes().length, 0); assert.equal([...f.scene.getInstancedEntityIds()].length, 0);
    assert.equal(f.population().flat.length, 0, 'no old native CPU piece is resurrected');
    assert.equal(f.attempts.length, 1, 'ownership refusal cannot silently retry or consume a replacement load');
  } finally { f.dispose(); }
});

it('#6993 actual ephemeral CPU release remains refused before replacement allocation', { timeout: 30_000 }, async t => {
  const f = await retainedStreamFixture(t, 1); if (!f) return;
  try {
    f.scene.setEphemeralStreamingMode(true); f.allocation.loseInitialDevice('Controlled ephemeral-source loss');
    assert.deepEqual(await f.result, { ok: false, reason: 'cpu-geometry-released' });
    assert.equal(f.allocation.deviceRequestCount(), 1); assert.equal(f.renderer.getGPUDevice(), null);
  } finally { f.dispose(); }
});
