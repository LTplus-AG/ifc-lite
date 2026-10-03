/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';
const { waitForMetadataRenderReadiness, sceneSettlement, guardViewerCompletion } = await tsImport('../tests/benchmark/metadata-render-readiness.ts', import.meta.url);

function snapshot(now, frameMs = now) {
  return { pagePerformanceMs: now, rendererFound: true, rendererReady: true,
    traversal: { complete: true }, canvas: { width: 715, height: 743 },
    load: { modelCount: 1, activeModelId: 'm', loading: false, streaming: false,
      error: null, pendingInstanceShards: 0, geometryMeshes: 1 },
    model: { id: 'm', loadState: 'complete', loadError: null, dataStorePresent: true },
    scene: { pendingBatches: false, queued: false, fragments: false, finalizing: false,
      geometryReleased: false, batchCount: 1, flatOwners: 1, instanceOwners: 0,
      instancedCount: 0, gpuInstanceOccurrences: 0 },
    frame: { drawCalls: 1, timestamp: frameMs }, debugFrameMatches: true,
    milestones: { uploadCount: 1, uploadMs: 0, geometryMs: 194, metadataMs: 265, error: null } };
}
function scenario({ metadataAt = 265, rendererAt = 200, canvasAt = 200, failedAt = Infinity } = {}) {
  let now = 0;
  const logs = [];
  const emitted = new Set();
  const events = [
    [194, '[useIfc] Stream complete for fixture.ifc: 194ms'],
    [200, '[ifc-lite] fixture.ifc (2.4MB) → 10 meshes, 20k verts in 0.2s'],
    [rendererAt, '[GeomStream] finalizeStreamingAsync complete: 10ms → 2 consolidated batches'],
    [metadataAt, '[useIfc] Data model parsing complete for fixture.ifc: 265ms'],
    [failedAt, '[useIfc] Data model parsing failed for fixture.ifc: 250ms'],
  ];
  return {
    logs: () => logs,
    now: () => now,
    sceneSnapshot: async () => {
      const witness = snapshot(now);
      witness.rendererFound = now >= rendererAt;
      witness.canvas.width = now >= canvasAt ? 715 : 0;
      return witness;
    },
    pause: async () => {
      now += 5;
      for (const [at, text] of events) if (at <= now && !emitted.has(text)) {
        emitted.add(text); logs.push(text);
      }
    },
    timeoutMs: 1000,
  };
}

test('#3978 early 200ms renderer summary cannot complete before 265ms metadata', async () => {
  assert.equal(await waitForMetadataRenderReadiness(scenario()), 265);
});
test('#3978 delayed metadata moves observed readiness without changing renderer summary', async () => {
  assert.equal(await waitForMetadataRenderReadiness(scenario({ metadataAt: 765 })), 765);
});
test('#3978 metadata alone cannot precede renderer readiness and allocated canvas', async () => {
  assert.equal(await waitForMetadataRenderReadiness(scenario({ rendererAt: 350, canvasAt: 450 })), 450);
});
test('#3978 absent metadata fails finitely instead of archiving a successful partial load', async () => {
  await assert.rejects(waitForMetadataRenderReadiness(scenario({ metadataAt: Infinity })), /Timed out/);
});
test('#3978 metadata failure is retained as failure even after geometry and canvas', async () => {
  await assert.rejects(waitForMetadataRenderReadiness(scenario({ failedAt: 250 })), /Metadata failed/);
});

test('#6537 app summary and allocated canvas cannot substitute for a ready scene', async () => {
  await assert.rejects(waitForMetadataRenderReadiness(scenario({ rendererAt: Infinity })), /Timed out/);
});
test('#3978 renderer initialization failure rejects an otherwise ready model', async () => {
  const input = scenario();
  input.logs = () => ['[Viewport] Renderer init failed: Failed to get GPU adapter'];
  await assert.rejects(waitForMetadataRenderReadiness(input), /Renderer failed/);
});

test('#6537 late full upload needs no streaming-finalize log and metadata needs no redraw', async () => {
  const input = scenario({ metadataAt: 765, rendererAt: 350 });
  input.sceneSnapshot = async () => snapshot(input.now(), 400);
  assert.equal(await waitForMetadataRenderReadiness(input), 765);
});
test('#6537 pre-upload or pre-geometry frame is refused despite settled scene', async () => {
  for (const frame of [0, 193]) {
    const input = scenario(); input.sceneSnapshot = async () => snapshot(input.now(), frame);
    await assert.rejects(waitForMetadataRenderReadiness(input), /Timed out/);
  }
});
test('#6537 each pending channel prevents readiness and unknown shape cannot pass', () => {
  for (const channel of ['pendingBatches', 'queued', 'fragments', 'finalizing']) {
    const witness = snapshot(300); witness.scene[channel] = true;
    assert.equal(sceneSettlement(witness), null, channel);
    delete witness.scene[channel];
    assert.throws(() => sceneSettlement(witness), /unknown scene/);
  }
  const pending = snapshot(300); pending.load.pendingInstanceShards = 1;
  assert.equal(sceneSettlement(pending), null);
  pending.load.pendingInstanceShards = null;
  assert.throws(() => sceneSettlement(pending), /unknown scene/);
  const partial = snapshot(300); partial.traversal.complete = false;
  assert.throws(() => sceneSettlement(partial), /incomplete renderer discovery/);
});
test('#6537 canonical Scene distinguishes full-upload completion from unfinalized fragments', async () => {
  const { Scene } = await tsImport('../packages/renderer/src/scene.ts', import.meta.url);
  const scene = new Scene(); scene.cachedMaxBufferSize = 256 * 1024 * 1024;
  // Only GPU allocation is adapted; routing, buckets, ownership, fragments and
  // finalization are the real Scene implementation used by the viewer.
  scene.createBatchedMesh = (meshes, color, _device, _pipeline, key) => ({
    id: 1, colorKey: key ?? 'fragment', color, indexCount: meshes.length * 3,
    vertexBuffer: { destroy() {} }, indexBuffer: { destroy() {} },
    expressIds: meshes.map(mesh => mesh.expressId), meshCount: meshes.length });
  const mesh = { expressId: 7, modelIndex: 0, color: [1, 0, 0, 1],
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) };
  const witness = () => {
    const result = snapshot(300);
    result.scene = { ...result.scene, pendingBatches: scene.hasPendingBatches(),
      queued: scene.hasQueuedMeshes(), fragments: scene.hasStreamingFragments(),
      finalizing: scene.isFinalizeInProgress(), geometryReleased: scene.isGeometryDataReleased(),
      batchCount: scene.getBatchedMeshes().length, flatOwners: scene.meshDataMap.size,
      instanceOwners: scene.getInstancedEntityCount(), instancedCount: scene.getInstancedEntityCount() };
    return result;
  };
  scene.appendToBatches([mesh], {}, {}, false);
  assert.ok(sceneSettlement(witness()), 'late complete upload builds full batches without streaming finalize');
  scene.appendToBatches([{ ...mesh, expressId: 8 }], {}, {}, true);
  assert.equal(sceneSettlement(witness()), null, 'streamed fragment cannot be treated as a settled full scene');
  scene.finalizeStreaming({}, {});
  assert.ok(sceneSettlement(witness()), 'real streaming consolidation satisfies the same contract');
});

test('#6537 reported GPU loss, validation and contained upload failures cannot certify a partial scene', async () => {
  for (const message of ['[Viewport] GPU device lost: unknown', '[Renderer] GPU device lost — halting rendering',
    '[WebGPU] Device lost: unexpected', '[WebGPU] Uncaptured error: validation',
    '[WebGPU] Validation error in render pass: bad binding',
    '[gpu] appendToBatches:non-streaming failed (device lost or out of GPU memory)',
    '[useGeometryStreaming] instanced shard upload failed (device lost?), skipping:']) {
    const input = scenario(); const currentLogs = input.logs;
    input.logs = () => [...currentLogs(), message];
    await assert.rejects(waitForMetadataRenderReadiness(input), /Renderer failed/, message);
  }
});

test('#6537 actual completion callbacks retain late identity faults and permit clean post-hash completion', async () => {
  const { frozenBeforeTeardown } = await tsImport('./perf/interleaved-diagnostics.ts', import.meta.url);
  for (const lateFault of [null, '[WebGPU] Device lost: during identity']) {
    const logs = ['[useIfc] Geometry streaming complete: 1 batch', '[useIfc] Data model parsing complete'];
    const events = [];
    await Promise.resolve().then(() => {
      if (lateFault) { logs.push(lateFault); events.push({ phase: 'post-readiness', kind: 'console', text: lateFault }); }
    });
    let eligibleCalls = 0, refusedCalls = 0;
    const receipt = guardViewerCompletion(logs,
      () => { eligibleCalls++; return frozenBeforeTeardown({ status: 'complete' }, events, { hashCompleted: true }, 100); },
      error => { refusedCalls++; return frozenBeforeTeardown({ status: 'refused', reason: String(error) }, events, { hashCompleted: true }, 100); });
    const actual = JSON.parse(receipt.captured);
    assert.equal(eligibleCalls, lateFault ? 0 : 1); assert.equal(refusedCalls, lateFault ? 1 : 0);
    assert.equal(actual.status, lateFault ? 'refused' : 'complete');
    assert.equal(actual.observed.hashCompleted, true);
    if (lateFault) { assert.match(actual.reason, /Renderer failed/); assert.equal(actual.events[0].text, lateFault); }
  }
  guardViewerCompletion(['[Vercel Web Analytics] Failed to load script', 'DBus warning'],
    () => undefined, error => assert.fail(String(error)));
});
