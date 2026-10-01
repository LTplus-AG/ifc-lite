/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
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
import { blankFile, load, wallMeshes, skip } from '@/test/blank-ifc-loader-harness.js';
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
});
