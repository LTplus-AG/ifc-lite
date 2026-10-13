/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { TestContext } from 'node:test';
import { act, useRef, useState } from 'react';
import { Renderer, FederationRegistry, type DeviceRecoveryResult } from '@ifc-lite/renderer';
import { decodeInstancedShard, type MeshData } from '@ifc-lite/geometry';
import { render, cleanup, advance } from './render';
import { recoveryAllocationDevice } from './recovery-allocation-device';
import { sectionNativeGeometry, sectionIndexedBounds, sourceDigest } from './section-native-geometry';
import { useViewerStore } from '@/store';
import { isTypeVisible } from '@/store/typeVisibilityFilter';
import { isMeshVisibleInViewMode, meshClassIsPlaced } from '@/lib/type-view-visibility';
import { useGeometryStreaming } from '@/components/viewer/useGeometryStreaming';
import { startDeviceLossRecovery } from '@/components/viewer/device-loss-recovery';

/** #6993: native source population and actual mounted queue/finalizer consumer.
 * GPU allocation only is substituted; no recovery, geometry or hook result is.
 */
export async function retainedStreamFixture(t: TestContext, models: 1 | 2, retry = false) {
  const runtime = readFileSync(new URL('../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
  const runtimeSHA = sourceDigest(runtime);
  if (process.env.IFC_LITE_NATIVE_TEST_WASM_SHA256) assert.equal(runtimeSHA, process.env.IFC_LITE_NATIVE_TEST_WASM_SHA256);
  const native = sectionNativeGeometry(t); if (!native) return null;
  const sourceSHA = sourceDigest(native.source);
  const occurrences = native.meshes.some(mesh => meshClassIsPlaced(mesh.geometryClass ?? 0));
  const visible = native.meshes.filter(mesh => isMeshVisibleInViewMode(mesh.geometryClass ?? 0, 'model', occurrences)
    && isTypeVisible(mesh.ifcType, useViewerStore.getState().typeVisibility));
  assert.equal(visible.length, 203); assert.equal(native.shard.instances.length, 42);
  const maxId = Math.max(...native.meshes.map(mesh => mesh.expressId), ...native.shard.instances.flatMap(instance => [instance.entityId, instance.itemId ?? 0]));
  const registry = new FederationRegistry(), indices = new Map<string, number>(), offsets = new Map<string, number>();
  const flat: MeshData[] = [], shards: Array<ReturnType<typeof decodeInstancedShard>> = [];
  for (let modelIndex = 0; modelIndex < models; modelIndex++) {
    const modelId = `native-${modelIndex}`;
    registry.registerModel(modelId, maxId); indices.set(modelId, modelIndex); offsets.set(modelId, registry.getOffset(modelId) ?? 0);
    for (const mesh of visible) flat.push({ ...mesh, expressId: registry.toGlobalId(modelId, mesh.expressId), modelIndex });
    const shard = decodeInstancedShard(native.shardBytes.slice());
    for (const instance of shard.instances) {
      instance.entityId = registry.toGlobalId(modelId, instance.entityId);
      if (typeof instance.itemId === 'number') instance.itemId = registry.toGlobalId(modelId, instance.itemId);
    }
    shards.push(shard);
  }
  const ids = [...new Set([...flat.map(mesh => mesh.expressId), ...shards.flatMap(shard => shard.instances.map(instance => instance.entityId))])];
  const allocation = recoveryAllocationDevice({ extraRecoveryAttempt: retry });
  const renderer = new Renderer(allocation.canvas), oracle = new Renderer(document.createElement('canvas'));
  let unsubscribe = () => { /* Installed after actual init. */ };
  let cancel = () => { /* Installed when actual loss starts recovery. */ };
  let publish: () => void = () => { throw new Error('Native queue owner is not mounted'); };
  let finish: () => void = () => { throw new Error('Native queue owner is not mounted'); };
  let wake: () => void = () => { throw new Error('Native queue owner is not mounted'); };
  let resolveResult!: (result: DeviceRecoveryResult) => void, rejectResult!: (error: unknown) => void;
  const result = new Promise<DeviceRecoveryResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const attempts: DeviceRecoveryResult[] = [];
  const noop = () => { /* This invariant queues no edits, visibility or color changes. */ };
  const dispose = () => { cancel(); unsubscribe(); cleanup(); renderer.destroy(); oracle.destroy(); allocation.restore(); };
  try {
    await renderer.init(); await renderer.enableQuantizedBatches();
    const device = renderer.getGPUDevice(), pipeline = renderer.getPipeline(); assert.ok(device); assert.ok(pipeline);
    oracle.getScene().appendToBatches(flat, device, pipeline);
    for (let i = 0; i < shards.length; i++) oracle.getScene().addInstancedShard(device, shards[i], i);
    const expectedBounds = sectionIndexedBounds(oracle.getScene(), ids);
    const expectedFlat = ids.flatMap(id => oracle.getScene().getMeshDataPieces(id) ?? []);
    const expectedInstances = ids.flatMap(id => oracle.getScene().getInstancedMeshDataPieces(id) ?? []);
    const Probe = () => {
      const [geometry, setGeometry] = useState(flat.slice(0, 32));
      const [streaming, setStreaming] = useState(true), [epoch, setEpoch] = useState(0);
      publish = () => setGeometry(flat); finish = () => setStreaming(false); wake = () => setEpoch(value => value + 1);
      const rendererRef = useRef(renderer), bounds = useRef(expectedBounds);
      const clearColor = useRef<[number, number, number, number]>([0, 0, 0, 1]);
      useGeometryStreaming({ rendererRef, isInitialized: true, gpuRecoveryEpoch: epoch, geometry,
        geometryVersion: 0, geometryReplacementVersion: 0, coordinateInfo: native.coordinateInfo,
        isStreaming: streaming, modelCount: models, geometryBoundsRef: bounds, clearColorRef: clearColor,
        pendingMeshColorUpdates: null, pendingColorUpdates: null, pendingMeshRemovals: null,
        pendingMeshTranslations: null, pendingMeshRotations: null, pendingInstancedShards: null,
        modelIdToIndex: indices, modelIdToOffset: offsets, presentInstancedModelIndices: new Set(indices.values()),
        clearPendingMeshColorUpdates: noop, clearPendingColorUpdates: noop, clearPendingMeshRemovals: noop,
        pruneGeometryMeshes: noop, clearPendingMeshTranslations: noop, clearPendingMeshRotations: noop, clearInstancedShards: noop });
      return <canvas />;
    };
    render(<Probe />);
    const scene = renderer.getScene();
    assert.equal(scene.flushPending(device, pipeline, 0), true);
    assert.equal(scene.hasStreamingFragments(), true);
    for (let i = 0; i < shards.length; i++) scene.addInstancedShard(device, shards[i], i);
    await act(async () => publish());
    assert.equal(scene.hasQueuedMeshes(), true);
    assert.equal(scene.getBatchedMeshes().reduce((sum, batch) => sum + batch.indexCount, 0), flat.slice(0, 32).reduce((sum, piece) => sum + piece.indices.length, 0));
    unsubscribe = renderer.onDeviceLost(() => {
      const recovery = startDeviceLossRecovery({ recoverDevice: async () => {
        const observed = await renderer.recoverDevice(); attempts.push(observed); return observed;
      } }, { recovered(observed) { wake(); resolveResult(observed); }, failed: resolveResult });
      cancel = recovery.cancel; void recovery.promise.catch(rejectResult);
    });
    const population = () => ({ flat: ids.flatMap(id => scene.getMeshDataPieces(id) ?? []), instances: ids.flatMap(id => scene.getInstancedMeshDataPieces(id) ?? []) });
    const assertPopulation = (expected: { flat: MeshData[]; instances: MeshData[]; bounds: typeof expectedBounds }) => {
      const actual = population();
      assert.equal(actual.flat.length, expected.flat.length); assert.equal(actual.instances.length, expected.instances.length);
      assert.deepEqual(actual.flat, expected.flat, 'all native flat positions/normals/indices/colors/origins and occurrence order survive');
      assert.deepEqual(actual.instances, expected.instances, 'every native IFNS transform, color, item and repeated occurrence survives');
      assert.deepEqual(sectionIndexedBounds(scene, ids), expected.bounds, 'independent complete indexed triangle extrema survive');
      assert.equal(scene.getBatchedMeshes().reduce((sum, batch) => sum + batch.indexCount, 0), flat.reduce((sum, piece) => sum + piece.indices.length, 0));
      assert.ok(scene.getBatchedMeshes().every(batch => allocation.live.has(batch.vertexBuffer)));
      assert.equal(scene.hasQueuedMeshes(), false); assert.equal(scene.hasStreamingFragments(), false);
      assert.equal(sourceDigest(native.source), sourceSHA);
    };
    const assertComplete = () => assertPopulation({ flat: expectedFlat, instances: expectedInstances, bounds: expectedBounds });
    const settle = async () => {
      assert.equal(renderer.isReady(), true);
      const dev = renderer.getGPUDevice(), pipe = renderer.getPipeline(); assert.ok(dev); assert.ok(pipe);
      for (let i = 0; scene.hasQueuedMeshes() && i < 16; i++) scene.flushPending(dev, pipe, 0);
      assert.equal(scene.hasQueuedMeshes(), false, 'bounded actual pending drain completes');
      for (let i = 0; (scene.hasStreamingFragments() || scene.isFinalizeInProgress()) && i < 200; i++) await advance(5);
    };
    return { renderer, scene, oracleScene: oracle.getScene(), ids, allocation, result, attempts, population, expectedFlat, expectedInstances, flat, runtimeSHA, sourceSHA,
      async begin() {
        allocation.holdReplacementPipelines(); allocation.loseInitialDevice('Controlled retained-stream first-fragment loss');
        const stage = await Promise.race([allocation.replacementRequested.then(() => 'replacement' as const), result]);
        assert.equal(stage, 'replacement', 'real retained native fragments must reach replacement instead of scene-not-settled refusal');
        const a = renderer.recoverDevice(), b = renderer.recoverDevice(); assert.equal(a, b, 'actual concurrent recovery calls coalesce');
      },
      async tickWhileHeld() {
        const before = population(); renderer.render(); await act(async () => finish());
        assert.equal(renderer.getGPUDevice(), null, 'staged replacement must not become a queue consumer before commit');
        assert.equal(renderer.isReady(), false); assert.equal(scene.hasQueuedMeshes(), true); assert.equal(scene.isFinalizeInProgress(), false);
        assert.deepEqual(population(), before, 'real frame and stream-end ticks cannot advance the pending cursor');
      },
      async enterPipelines() { allocation.releaseReplacement(); await allocation.pipelineRequested; },
      async complete() {
        await act(async () => { allocation.releaseReplacementPipelines(); assert.equal((await result).ok, true); });
        await settle();
        assertComplete();
      },
      async settleManualRecovery() { await act(async () => wake()); await settle(); },
      assertCurrentOracle() {
        assertPopulation({ flat: ids.flatMap(id => oracle.getScene().getMeshDataPieces(id) ?? []),
          instances: ids.flatMap(id => oracle.getScene().getInstancedMeshDataPieces(id) ?? []),
          bounds: sectionIndexedBounds(oracle.getScene(), ids) });
      }, assertComplete, dispose };
  } catch (error) { dispose(); throw error; }
}
