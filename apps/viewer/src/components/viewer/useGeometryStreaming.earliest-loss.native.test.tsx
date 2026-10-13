/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { act, useCallback, useEffect, useRef, useState } from 'react';
import { Renderer } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { render, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { isTypeVisible } from '@/store/typeVisibilityFilter';
import { recoveryAllocationDevice } from '@/test/recovery-allocation-device';
import { sectionNativeGeometry, sectionIndexedBounds, sourceDigest } from '@/test/section-native-geometry';
import { isMeshVisibleInViewMode, meshClassIsPlaced } from '@/lib/type-view-visibility';
import { subscribeViewportHealth, resetDeviceLossReportForTests } from './device-loss-report';
import { useGeometryStreaming } from './useGeometryStreaming';

it('#6993/#7484 early device loss retains the real FZK flat and IFNS population after actual renderer recovery', { timeout: 30_000 }, async t => {
  const parsed = sectionNativeGeometry(t); if (!parsed) return;
  const native = parsed;
  const sourceSHA = sourceDigest(native.source);
  const hasOccurrences = native.meshes.some(mesh => meshClassIsPlaced(mesh.geometryClass ?? 0));
  const typeVisibility = useViewerStore.getState().typeVisibility;
  const flat = native.meshes.filter(mesh => isMeshVisibleInViewMode(mesh.geometryClass ?? 0, 'model', hasOccurrences)
    && isTypeVisible(mesh.ifcType, typeVisibility));
  assert.equal(flat.length, 203, 'real native visible flat population is mandatory');
  assert.equal(native.shard.instances.length, 42, 'real native IFNS occurrences are mandatory');
  for (const mesh of flat) mesh.modelIndex = 0;
  const allocation = recoveryAllocationDevice();
  const renderer = new Renderer(allocation.canvas), oracle = new Renderer(document.createElement('canvas'));
  const ids = [...new Set([...flat.map(mesh => mesh.expressId), ...native.shard.instances.map(instance => instance.entityId)])];
  const modelIndices = new Map([['native', 0]]), offsets = new Map([['native', 0]]), present = new Set([0]);
  const noop = () => { /* No edit/color work is queued by this source-load invariant. */ };
  let publishFlat: () => void = () => { throw new Error('Viewport not mounted'); };
  let publishShard: () => void = () => { throw new Error('Viewport not mounted'); };
  let completeRecovery!: () => void;
  const recovered = new Promise<void>(resolve => { completeRecovery = resolve; });
  resetDeviceLossReportForTests();
  useViewerStore.setState({ ...fixtureModels(fixtureModel('native', { idOffset: 0 })), activeStreamCanceller: null });
  try {
    await renderer.init();
    assert.equal(renderer.isReady(), true, 'actual initial Renderer.init completes before loss');
    const firstDevice = renderer.getGPUDevice(), firstPipeline = renderer.getPipeline();
    assert.ok(firstDevice); assert.ok(firstPipeline);
    oracle.getScene().appendToBatches(flat, firstDevice, firstPipeline);
    oracle.getScene().addInstancedShard(firstDevice, native.shard, 0);
    const completeBounds = sectionIndexedBounds(oracle.getScene(), ids);
    const Probe = () => {
      const [geometry, setGeometry] = useState<MeshData[] | null>(null);
      const [streaming, setStreaming] = useState(true);
      const [epoch, setEpoch] = useState(0);
      const [shards, setShards] = useState<Array<{ modelId: string; bytes: ArrayBuffer }> | null>(null);
      const clearShards = useCallback(() => setShards(null), []);
      const rendererRef = useRef(renderer);
      const bounds = useRef({ min: { x: -100, y: -100, z: -100 }, max: { x: 100, y: 100, z: 100 } });
      const clearColor = useRef<[number, number, number, number]>([0, 0, 0, 1]);
      publishFlat = () => { setGeometry(flat); setStreaming(false); };
      publishShard = () => setShards([{ modelId: 'native', bytes: native.shardBytes.slice().buffer }]);
      useEffect(() => subscribeViewportHealth(renderer, undefined, () => {
        setEpoch(value => value + 1); completeRecovery();
      }), []);
      // The extra epoch is an actual Viewport input on the candidate. Passing
      // this variable to the original API keeps the negative control loadable.
      const params: Parameters<typeof useGeometryStreaming>[0] & { gpuRecoveryEpoch: number } = {
        rendererRef, isInitialized: true, gpuRecoveryEpoch: epoch, geometry,
        geometryVersion: 0, geometryReplacementVersion: 0, coordinateInfo: native.coordinateInfo,
        isStreaming: streaming, modelCount: 1, geometryBoundsRef: bounds,
        pendingMeshColorUpdates: null, pendingColorUpdates: null, pendingMeshRemovals: null,
        pendingMeshTranslations: null, pendingMeshRotations: null, pendingInstancedShards: shards,
        modelIdToIndex: modelIndices, modelIdToOffset: offsets, presentInstancedModelIndices: present,
        clearPendingMeshColorUpdates: noop, clearPendingColorUpdates: noop, clearPendingMeshRemovals: noop,
        pruneGeometryMeshes: noop, clearPendingMeshTranslations: noop, clearPendingMeshRotations: noop,
        clearInstancedShards: clearShards, clearColorRef: clearColor,
      };
      useGeometryStreaming(params);
      return <canvas />;
    };
    const ui = render(<Probe />);
    allocation.loseBeforeFirstFlatUpload();
    await allocation.replacementRequested;
    assert.equal(renderer.isDeviceLost(), true, 'production device.lost subscription latched the early loss');
    assert.equal(renderer.getGPUDevice(), null, 'replacement request is genuinely pending');
    await act(async () => publishFlat());
    assert.equal(renderer.getScene().getBatchedMeshes().length, 0, 'source completed while flat uploads were unavailable');
    await act(async () => { allocation.releaseReplacement(); await recovered; });
    assert.equal(renderer.isReady(), true, 'production recoverDevice and Viewport success callback completed');
    assert.notEqual(renderer.getGPUDevice(), firstDevice); assert.notEqual(renderer.getPipeline(), firstPipeline);
    // Native IFNS arrives after recovery, reproducing the recorded incomplete
    // population without substituting a fake shard or changing flat inputs.
    await act(async () => publishShard());
    const scene = renderer.getScene();
    const instances = ids.flatMap(id => scene.getInstancedMeshDataPieces(id) ?? []);
    assert.equal(instances.length, 42, 'actual native instance consumer works before the flat recovery assertion');
    const retainedFlat = [...new Set(flat.map(mesh => mesh.expressId))].flatMap(id => scene.getMeshDataPieces(id) ?? []);
    assert.equal(retainedFlat.length, 203, 'recovery retains all visible native flat owners after earliest device loss');
    const batches = scene.getBatchedMeshes();
    assert.ok(batches.length > 0, 'retained flat triangles own actual replacement GPU batches');
    assert.equal(batches.reduce((sum, batch) => sum + batch.indexCount, 0),
      flat.reduce((sum, mesh) => sum + mesh.indices.length, 0), 'GPU batches retain every native flat triangle exactly once');
    assert.ok(batches.every(batch => allocation.live.has(batch.vertexBuffer)), 'replacement vertex buffers are live allocation owners');
    assert.deepEqual(sectionIndexedBounds(scene, ids), completeBounds, 'all indexed extrema retain the complete source population');
    assert.ok(ui.querySelector('canvas')); assert.equal(sourceDigest(native.source), sourceSHA);
  } finally {
    cleanup(); renderer.destroy(); oracle.destroy(); allocation.restore();
  }
});
