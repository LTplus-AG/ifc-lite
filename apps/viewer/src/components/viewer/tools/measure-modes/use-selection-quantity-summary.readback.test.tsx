/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { StoreApi } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { cleanup, render } from '@/test/render';
import { fixtureModel } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { geometryBackingCommand } from '@/lib/geometry-backing/backing-debug-hook';
import type { TapState } from '@/lib/geometry-backing/store-backing-tap';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import { setReleasedGeometryMetadata } from '@/lib/geometry-backing/released-geometry-metadata';
import { useSelectionQuantitySummary } from './use-selection-quantity-summary';

function Summary() {
  const { summary } = useSelectionQuantitySummary();
  return <output>{JSON.stringify(summary?.meshArea)}</output>;
}

for (const legacy of [false, true]) {
it(`#10887 a partly released ${legacy ? 'legacy' : 'federated'} entity reports its whole backed area or no area`, async () => {
  const initial = useViewerStore.getState();
  const piece = (width: number): MeshData => ({ expressId: 42, ifcType: 'IfcWall',
    positions: Float32Array.from([0, 0, 0, width, 0, 0, 0, 2, 0]),
    normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] });
  const meshes = [piece(3), piece(6)];
  const geometry: GeometryResult = { meshes, totalTriangles: 2, totalVertices: 6,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 6, y: 2, z: 0 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 6, y: 2, z: 0 } } } };
  const modelId = legacy ? '__legacy__' : 'm';
  const models = new Map([[modelId, {
    ...fixtureModel(modelId), geometryResult: geometry, ifcDataStore: null,
  }]]);
  useViewerStore.setState({ models: legacy ? new Map() : models,
    geometryResult: geometry, ifcDataStore: null, activeModelId: legacy ? null : modelId,
    selectedEntity: { modelId: legacy ? 'legacy' : modelId, expressId: 42 }, selectedEntitiesSet: new Set() });
  // The backing's model-aware adapter remains stable while the legacy hook
  // reads its supported geometryResult-only view of the same live geometry.
  const store = legacy
    ? createStore<TapState>(() => ({ models, geometryContentVersion: 0 }))
    : useViewerStore as unknown as StoreApi<TapState>;
  const area = () => {
    const ui = render(<Summary />);
    const value = JSON.parse(ui.querySelector('output')!.textContent!);
    cleanup();
    return value;
  };
  try {
    await geometryBackingCommand(store, undefined, { action: 'start', options: {
      database: { name: `mixed-area-${process.pid}-${legacy}`, locks: null },
    } as never });
    const rows = await geometryBackingCommand(store, undefined, { action: 'seal' });
    assert.ok(rows.every((row) => 'complete' in row && row.complete));
    assert.deepEqual(area(), { total: 9, withMesh: 1, withoutMesh: 0 });
    releaseCpuMeshBuffers([meshes[0]]);
    assert.deepEqual(area(), { total: 9, withMesh: 1, withoutMesh: 0 }, 'never report the resident piece alone');
    setReleasedGeometryMetadata(null);
    assert.deepEqual(area(), { total: 0, withMesh: 0, withoutMesh: 1 }, 'unavailable backing must not leave a partial area');
  } finally {
    cleanup();
    await geometryBackingCommand(store, undefined, { action: 'stop' });
    useViewerStore.setState(initial, true);
  }
});
}
