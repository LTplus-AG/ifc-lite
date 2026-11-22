/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { act } from 'react';
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
  let ui: HTMLElement;
  const area = () => JSON.parse(ui.querySelector('output')!.textContent!);
  try {
    await geometryBackingCommand(store, undefined, { action: 'start', options: {
      database: { name: `mixed-area-${process.pid}-${legacy}`, locks: null },
    } as never });
    const rows = await geometryBackingCommand(store, undefined, { action: 'seal' });
    assert.ok(rows.every((row) => 'complete' in row && row.complete));
    ui = render(<Summary />);
    assert.deepEqual(area(), { total: 9, withMesh: 1, withoutMesh: 0 });
    act(() => releaseCpuMeshBuffers([meshes[0]]));
    assert.deepEqual(area(), { total: 9, withMesh: 1, withoutMesh: 0 }, 'never report the resident piece alone');
    act(() => setReleasedGeometryMetadata(null));
    assert.deepEqual(area(), { total: 0, withMesh: 0, withoutMesh: 1 }, 'unavailable backing must not leave a partial area');
  } finally {
    cleanup();
    await geometryBackingCommand(store, undefined, { action: 'stop' });
    useViewerStore.setState(initial, true);
  }
});
}

it('#10887 overlapping model IDs keep each model area before and after one releases', async () => {
  const initial = useViewerStore.getState();
  const mesh = (area: number): MeshData => ({ expressId: 42,
    positions: Float32Array.from([0, 0, 0, area, 0, 0, 0, 2, 0]),
    normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] });
  const geometry = (m: MeshData): GeometryResult => ({ meshes: [m], totalTriangles: 1, totalVertices: 3,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 6, y: 2, z: 0 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 6, y: 2, z: 0 } } } });
  const a = mesh(3), b = mesh(6);
  const models = new Map([
    ['A', { ...fixtureModel('A', { idOffset: 0 }), geometryResult: geometry(a), ifcDataStore: null }],
    ['B', { ...fixtureModel('B', { idOffset: 0 }), geometryResult: geometry(b), ifcDataStore: null }],
  ]);
  useViewerStore.setState({ models, geometryResult: null, ifcDataStore: null, activeModelId: 'A',
    selectedEntity: { modelId: 'A', expressId: 42 }, selectedEntitiesSet: new Set() });
  const store = useViewerStore as unknown as StoreApi<TapState>;
  try {
    await geometryBackingCommand(store, undefined, { action: 'start', options: {
      database: { name: `overlapping-area-${process.pid}`, locks: null },
    } as never });
    await geometryBackingCommand(store, undefined, { action: 'seal' });
    const ui = render(<Summary />);
    const area = () => JSON.parse(ui.querySelector('output')!.textContent!);
    const select = (modelId: string) => act(() => useViewerStore.setState({ selectedEntity: { modelId, expressId: 42 } }));
    assert.equal(area().total, 3);
    select('B');
    assert.equal(area().total, 6, 'same express id in a second model is a different entity');
    act(() => releaseCpuMeshBuffers([a]));
    assert.equal(area().total, 6, 'releasing A cannot replace B’s resident area');
    select('A');
    assert.equal(area().total, 3, 'A reads its own backed area');
    act(() => setReleasedGeometryMetadata(null));
    assert.deepEqual(area(), { total: 0, withMesh: 0, withoutMesh: 1 });
    select('B');
    assert.equal(area().total, 6, 'loss of A’s backing cannot erase B’s resident area');
  } finally {
    cleanup();
    await geometryBackingCommand(store, undefined, { action: 'stop' });
    useViewerStore.setState(initial, true);
  }
});

it('#10887 in-place release invalidates an already mounted area without a backing', () => {
  const initial = useViewerStore.getState();
  const mesh: MeshData = { expressId: 42, positions: Float32Array.from([0, 0, 0, 3, 0, 0, 0, 2, 0]),
    normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] };
  const model = fixtureModel('m');
  const geometry: GeometryResult = { meshes: [mesh], totalTriangles: 1, totalVertices: 3,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 2, z: 0 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 2, z: 0 } } } };
  useViewerStore.setState({ models: new Map([['m', { ...model, geometryResult: geometry, ifcDataStore: null }]]),
    geometryResult: geometry, selectedEntity: { modelId: 'm', expressId: 42 }, selectedEntitiesSet: new Set() });
  setReleasedGeometryMetadata(null);
  try {
    const ui = render(<Summary />);
    const area = () => JSON.parse(ui.querySelector('output')!.textContent!);
    assert.equal(area().total, 3);
    act(() => releaseCpuMeshBuffers([mesh]));
    assert.deepEqual(area(), { total: 0, withMesh: 0, withoutMesh: 1 }, 'a released result is unavailable, not a stale area');
  } finally {
    cleanup();
    useViewerStore.setState(initial, true);
  }
});

function wallGeometry(): { meshes: MeshData[]; geometry: GeometryResult } {
  const piece = (width: number): MeshData => ({ expressId: 42, ifcType: 'IfcWall',
    positions: Float32Array.from([0, 0, 0, width, 0, 0, 0, 2, 0]),
    normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] });
  const meshes = [piece(3), piece(6)];
  return { meshes, geometry: { meshes, totalTriangles: 2, totalVertices: 6,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 6, y: 2, z: 0 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 6, y: 2, z: 0 } } } } };
}

it('#10887 a `legacy` selection of a model stored under __legacy__ reports its area, resident and released', async () => {
  const initial = useViewerStore.getState();
  const { meshes, geometry } = wallGeometry();
  useViewerStore.setState({ models: new Map([['__legacy__', { ...fixtureModel('__legacy__'), geometryResult: geometry, ifcDataStore: null }]]),
    geometryResult: geometry, ifcDataStore: null, activeModelId: null,
    selectedEntity: { modelId: 'legacy', expressId: 42 }, selectedEntitiesSet: new Set() });
  const store = useViewerStore as unknown as StoreApi<TapState>;
  let ui: HTMLElement;
  const area = () => JSON.parse(ui.querySelector('output')!.textContent!);
  try {
    await geometryBackingCommand(store, undefined, { action: 'start', options: {
      database: { name: `legacy-key-area-${process.pid}`, locks: null } } as never });
    await geometryBackingCommand(store, undefined, { action: 'seal' });
    ui = render(<Summary />);
    assert.deepEqual(area(), { total: 9, withMesh: 1, withoutMesh: 0 }, 'resident');
    act(() => releaseCpuMeshBuffers(meshes));
    assert.deepEqual(area(), { total: 9, withMesh: 1, withoutMesh: 0 }, 'released, from the backed areas');
  } finally {
    cleanup();
    await geometryBackingCommand(store, undefined, { action: 'stop' });
    useViewerStore.setState(initial, true);
  }
});

it('#10887 a content-version-only bump withdraws a mounted released area at once', async () => {
  const initial = useViewerStore.getState();
  const { meshes, geometry } = wallGeometry();
  useViewerStore.setState({ models: new Map([['cv', { ...fixtureModel('cv'), geometryResult: geometry, ifcDataStore: null }]]),
    geometryResult: geometry, ifcDataStore: null, activeModelId: 'cv',
    selectedEntity: { modelId: 'cv', expressId: 42 }, selectedEntitiesSet: new Set() });
  const store = useViewerStore as unknown as StoreApi<TapState>;
  let ui: HTMLElement;
  const area = () => JSON.parse(ui.querySelector('output')!.textContent!);
  try {
    await geometryBackingCommand(store, undefined, { action: 'start', options: {
      database: { name: `content-bump-area-${process.pid}`, locks: null } } as never });
    await geometryBackingCommand(store, undefined, { action: 'seal' });
    ui = render(<Summary />);
    act(() => releaseCpuMeshBuffers(meshes));
    assert.deepEqual(area(), { total: 9, withMesh: 1, withoutMesh: 0 });
    // Same models, same lists: only the content version moves, superseding the sealed backing.
    act(() => useViewerStore.getState().bumpGeometryContentVersion());
    assert.deepEqual(area(), { total: 0, withMesh: 0, withoutMesh: 1 }, 'the superseded backing no longer answers');
  } finally {
    cleanup();
    await geometryBackingCommand(store, undefined, { action: 'stop' });
    useViewerStore.setState(initial, true);
  }
});
