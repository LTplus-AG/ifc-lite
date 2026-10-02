/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, useMemo, useRef } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { Camera } from '../../../../../packages/renderer/src/camera.js';
import { useViewerStore } from '@/store';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records.js';
import { toGlobalIdFromModels } from '@/store/globalId.js';
import { requestRemesh } from '@/lib/remesh/remesh-service.js';
import { modelIndices } from '@/lib/model-placement/model-indices.js';
import { appearanceInstanceScene } from '@/test/appearance-instance-scene.js';
import { blankFile, load, wallMeshes, skip, installRealRemesh } from '@/test/blank-ifc-loader-harness.js';
import { render, cleanup, waitFor } from '@/test/render.js';
import { useFederatedGeometry } from './useFederatedGeometry.js';
import { useGeometryStreaming } from './useGeometryStreaming.js';

/** Actual viewport source reconciliation, drain and real Scene. Only browser
 * GPU allocation/presentation is replaced; IFC production is the real WASM. */
function Viewport({ renderer }: { renderer: Renderer }) {
  const s = useViewerStore();
  const indices = useMemo(() => modelIndices(s.models), [s.models]);
  const geometry = useFederatedGeometry(s.models, s.geometryResult, indices, s.geometryContentVersion);
  const rendererRef = useRef<Renderer | null>(renderer);
  const geometryBoundsRef = useRef({ min: { x: -100, y: -100, z: -100 }, max: { x: 100, y: 100, z: 100 } });
  const clearColorRef = useRef<[number, number, number, number]>([0, 0, 0, 1]);
  useGeometryStreaming({ rendererRef, geometry: geometry?.meshes ?? null,
    appearanceSourceGeometry: geometry?.meshes, coordinateInfo: geometry?.coordinateInfo,
    geometryVersion: s.geometryUpdateTick, geometryContentVersion: s.geometryContentVersion,
    modelCount: s.models.size, modelIdToIndex: indices,
    presentInstancedModelIndices: new Set(indices.values()), isInitialized: true, isStreaming: false,
    geometryBoundsRef, clearColorRef, pendingMeshColorUpdates: null, pendingColorUpdates: null,
    pendingMeshRemovals: s.pendingMeshRemovals, pendingMeshTranslations: null,
    pendingMeshRotations: null, pendingInstancedShards: null,
    clearPendingMeshColorUpdates: s.clearPendingMeshColorUpdates, clearPendingColorUpdates: s.clearPendingColorUpdates,
    clearPendingMeshRemovals: s.clearPendingMeshRemovals, pruneGeometryMeshes: s.pruneGeometryMeshes,
    clearPendingMeshTranslations: s.clearPendingMeshTranslations, clearPendingMeshRotations: s.clearPendingMeshRotations,
    clearInstancedShards: s.clearInstancedShards });
  return null;
}

function mountViewport() {
  const native = appearanceInstanceScene([]);
  const camera = new Camera();
  const renderer = { getScene: () => native.scene, getGPUDevice: () => native.device, getPipeline: () => native.pipeline,
    getCamera: () => camera, getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }),
    clearCaches() {}, requestRender() {} } as unknown as Renderer;
  render(<Viewport renderer={renderer} />);
  return { ...native, camera };
}

async function newWall(modelId: string, y = 3) {
  const model = useViewerStore.getState().models.get(modelId);
  const storey = model?.ifcDataStore?.entityIndex.byType.get('IFCBUILDINGSTOREY')?.[0];
  assert.ok(storey);
  assert.ok(modelEditTarget(useViewerStore.getState(), modelId));
  const wall = useViewerStore.getState().addWall(modelId, storey,
    { Start: [2, y, 0], End: [6, y, 0], Thickness: 0.2, Height: 3 });
  assert.ok('expressId' in wall);
  return wall.expressId;
}

describe('first authored mesh resident ownership (#6232)', () => {
  for (const unit of ['METRE', 'MILLIMETRE'] as const) {
    for (const count of [1, 2]) {
      it(`${unit}, ${count} models: first real wall occupies its Scene once and still fits the camera`, { skip }, async () => {
        const primary = await load(blankFile(unit));
        if (count === 2) await load(blankFile(unit), 'blank-peer');
        const { scene, device, pipeline } = appearanceInstanceScene([]);
        const camera = new Camera();
        const renderer = { getScene: () => scene, getGPUDevice: () => device, getPipeline: () => pipeline,
          getCamera: () => camera, getCanvas: () => ({ clientWidth: 800, clientHeight: 600 }),
          clearCaches() {}, requestRender() {} } as unknown as Renderer;
        render(<Viewport renderer={renderer} />);
        try {
          const storey = primary.ifcDataStore?.entityIndex.byType.get('IFCBUILDINGSTOREY')?.[0];
          assert.ok(storey);
          assert.ok(modelEditTarget(useViewerStore.getState(), primary.id));
          const wall = useViewerStore.getState().addWall(primary.id, storey,
            { Start: [2, 3, 0], End: [6, 3, 0], Thickness: 0.2, Height: 3 });
          assert.ok('expressId' in wall);
          await act(async () => {
            assert.equal((await requestRemesh(useViewerStore.getState, primary.id, [wall.expressId], 'created')).status, 'applied');
          });
          await waitFor(() => useViewerStore.getState().pendingMeshEdits === null, 'actual viewport drains the new wall');
          const globalId = toGlobalIdFromModels(useViewerStore.getState().models, primary.id, wall.expressId);
          const cpu = wallMeshes(primary.id, wall.expressId);
          assert.ok(cpu.length > 0 && cpu.every(mesh => mesh.indices.length > 0));
          const resident = scene.getMeshDataPieces(globalId) ?? [];
          assert.equal(resident.length, cpu.length, 'each actual WASM part has exactly one resident Scene part');
          assert.equal(resident.reduce((n, mesh) => n + mesh.indices.length, 0),
            cpu.reduce((n, mesh) => n + mesh.indices.length, 0), 'first camera fitting must not upload triangles twice');
          assert.notDeepEqual(camera.getTarget(), { x: 0, y: 0, z: 0 }, 'first geometry still fits the camera');
        } finally {
          cleanup();
          scene.clear();
        }
      });
    }
  }

  it('triangle partitions sharing the same IFC item remain distinct resident parts', { skip }, async () => {
    const primary = await load(blankFile('METRE'));
    installRealRemesh(meshes => meshes.flatMap(mesh => {
      assert.ok(mesh.indices.length >= 6 && mesh.indices.length % 6 === 0);
      const middle = mesh.indices.length / 2;
      // A stated invariant: partition the actual engine triangles without
      // changing vertices, item identity, placement, style or triangle order.
      return [{ ...mesh, indices: mesh.indices.slice(0, middle) },
        { ...mesh, indices: mesh.indices.slice(middle) }];
    }));
    const { scene } = mountViewport();
    try {
      const id = await newWall(primary.id);
      await act(async () => {
        assert.equal((await requestRemesh(useViewerStore.getState, primary.id, [id], 'created')).status, 'applied');
      });
      const cpu = wallMeshes(primary.id, id);
      assert.equal(cpu.length, 2);
      assert.equal(cpu[0].geometryItemId, cpu[1].geometryItemId);
      const resident = scene.getMeshDataPieces(cpu[0].expressId) ?? [];
      assert.equal(resident.length, 2, 'source slots preserve both parts without doubling or collapsing them');
      assert.deepEqual(resident.map(mesh => Array.from(mesh.indices)), cpu.map(mesh => Array.from(mesh.indices)));
    } finally { cleanup(); scene.clear(); }
  });

  it('a failed real Scene upload stays queued and a later replacement retries it once', { skip }, async () => {
    const primary = await load(blankFile('METRE'));
    const { scene, device } = mountViewport();
    const allocate = device.createBuffer.bind(device);
    let blocked = true;
    mock.method(device, 'createBuffer', (descriptor: GPUBufferDescriptor) => {
      if (blocked) throw new RangeError('Test GPU transport refuses allocation');
      return allocate(descriptor);
    });
    try {
      const id = await newWall(primary.id);
      await act(async () => {
        assert.equal((await requestRemesh(useViewerStore.getState, primary.id, [id], 'created')).status, 'applied');
      });
      const cpu = wallMeshes(primary.id, id);
      assert.ok(useViewerStore.getState().pendingMeshEdits, 'failed allocation must not acknowledge the edit');
      // Scene retains CPU ownership before attempting GPU allocation; only
      // the actual draw batches must remain absent while allocation refuses.
      assert.equal(scene.getBatchedMeshes().length, 0);
      blocked = false;
      act(() => useViewerStore.getState().replaceEntityMeshes(primary.id, new Map([[cpu[0].expressId, cpu]])));
      await waitFor(() => useViewerStore.getState().pendingMeshEdits === null, 'next canonical replacement retries allocation');
      assert.equal(scene.getMeshDataPieces(cpu[0].expressId)?.length, cpu.length);
      assert.ok(scene.getBatchedMeshes().length > 0, 'successful retry supplies actual draw batches');
    } finally { cleanup(); scene.clear(); }
  });

  it('an unrelated real mesh appended in the same commit remains present after the mixed-tick rebuild', { skip }, async () => {
    const primary = await load(blankFile('METRE'));
    const first = await newWall(primary.id);
    assert.equal((await requestRemesh(useViewerStore.getState, primary.id, [first], 'created')).status, 'applied');
    const firstMeshes = wallMeshes(primary.id, first);
    const second = await newWall(primary.id, 7);
    assert.equal((await requestRemesh(useViewerStore.getState, primary.id, [second], 'created')).status, 'applied');
    const secondMeshes = wallMeshes(primary.id, second);
    // Start the real viewport at the actual empty resident state. Reuse the
    // two real mesher outputs in a canonical append+replacement transaction.
    useViewerStore.getState().replaceEntityMeshes(primary.id,
      new Map([[firstMeshes[0].expressId, []], [secondMeshes[0].expressId, []]]));
    useViewerStore.getState().clearPendingMeshEdits();
    const { scene } = mountViewport();
    try {
      act(() => {
        useViewerStore.getState().appendGeometryBatch(primary.id, secondMeshes);
        useViewerStore.getState().replaceEntityMeshes(primary.id, new Map([[firstMeshes[0].expressId, firstMeshes]]));
      });
      await waitFor(() => useViewerStore.getState().pendingMeshEdits === null, 'mixed update drains');
      assert.equal(scene.getMeshDataPieces(firstMeshes[0].expressId)?.length, firstMeshes.length);
      assert.equal(scene.getMeshDataPieces(secondMeshes[0].expressId)?.length, secondMeshes.length);
    } finally { cleanup(); scene.clear(); }
  });
});
