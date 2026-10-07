/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7021: what the viewport sees while one model streams in, through the real
 * store actions and the same hook chain `ViewportContainer` runs
 * (`modelIndices` -> `useFederatedGeometry` -> `useFilteredGeometry`). These
 * pin the OUTPUT (which meshes, in which order, with which modelIndex, and
 * that in-place edits to a store mesh stay visible), so the per-append cost
 * can change without the result changing.
 */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useMemo } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import { perfCounters } from '@ifc-lite/load-trace';
import { useViewerStore, type FederatedModel } from '@/store';
import { modelIndices } from '@/lib/model-placement/model-indices.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { cleanup, render } from '@/test/render.js';
import { useFederatedGeometry } from './useFederatedGeometry.js';
import { useFilteredGeometry } from './useFilteredGeometry.js';
import { useAppearanceSourceGeometry } from './useAppearanceSourceGeometry.js';

const coordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  hasLargeCoordinates: false,
};

let seen: { merged: MeshData[]; filtered: MeshData[]; hasType: boolean; version: number; appearance: MeshData[] } | null = null;

function Probe() {
  const s = useViewerStore();
  const indices = useMemo(() => modelIndices(s.models), [s.models]);
  const merged = useFederatedGeometry(s.models, s.geometryResult, indices, s.geometryContentVersion);
  const { filteredGeometry, hasTypeGeometry, geometryVersion } = useFilteredGeometry(
    merged, s.geometryContentVersion, s.typeVisibility, s.typeViewMode);
  const appearance = useAppearanceSourceGeometry(s.models, indices, s.geometryContentVersion);
  seen = { merged: merged?.meshes ?? [], filtered: [...(filteredGeometry ?? [])], hasType: hasTypeGeometry, version: geometryVersion, appearance };
  return null;
}

afterEach(() => {
  cleanup();
  useViewerStore.getState().clearAllModels();
  modelIndices(new Map());
  seen = null;
});

let nextId = 1;
function mesh(ifcType = 'IfcWall', geometryClass?: number): MeshData {
  const id = nextId++;
  return {
    expressId: id, ifcType, color: [0.5, 0.5, 0.5, 1], ...(geometryClass === undefined ? {} : { geometryClass }),
    positions: new Float32Array([id, 0, 0, id + 1, 0, 0, id, 1, 0]),
    normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]),
  } as MeshData;
}

function startLoad(id: string): void {
  const model = { ...fixtureModel(id), geometryResult: null } as unknown as FederatedModel;
  act(() => { useViewerStore.getState().upsertModel(model); });
}

function append(id: string, meshes: MeshData[]): void {
  act(() => { useViewerStore.getState().appendGeometryBatch(id, meshes, coordinateInfo); });
}

const ids = (list: readonly MeshData[]) => list.map((m) => m.expressId);

it('streams a single model into the viewport in order, filtered, with its model index (#7021)', () => {
  // Openings hidden, so the filter has something to drop.
  if (useViewerStore.getState().typeVisibility.openings) act(() => { useViewerStore.getState().toggleTypeVisibility('openings'); });
  startLoad('m');
  render(<Probe />);
  const appended: MeshData[] = [];
  for (let batch = 0; batch < 6; batch++) {
    const part = [mesh(), mesh('IfcOpeningElement'), mesh('IfcSlab')];
    appended.push(...part);
    append('m', part);
    assert.deepEqual(ids(seen!.merged), ids(appended), `merged after batch ${batch}`);
    const visible = appended.filter((m) => m.ifcType !== 'IfcOpeningElement');
    assert.deepEqual(ids(seen!.filtered), ids(visible), `filtered after batch ${batch}`);
    for (const m of seen!.merged) assert.equal(m.modelIndex, 0);
    // The viewport's mesh carries the store mesh's own buffers.
    assert.equal(seen!.merged.at(-1)!.positions, part.at(-1)!.positions);
  }
  assert.equal(seen!.hasType, false);
});

it('picks up type geometry that streams in a later batch (#957, #7021)', () => {
  startLoad('m');
  render(<Probe />);
  append('m', [mesh(), mesh()]);
  assert.equal(seen!.hasType, false);
  append('m', [mesh('IfcWallType', 1)]);
  assert.equal(seen!.hasType, true);
});

it('keeps in-place edits to a store mesh visible after the next write (#7021)', () => {
  startLoad('m');
  render(<Probe />);
  const first = mesh();
  append('m', [first, mesh()]);
  // releaseGeometryMemory, alignment restores and the loader's colour pass
  // reassign fields on the store's own mesh objects.
  const released = new Float32Array(0);
  const stored = useViewerStore.getState().models.get('m')!.geometryResult!.meshes[0];
  stored.positions = released;
  stored.color = [1, 0, 0, 1];
  append('m', [mesh()]);
  assert.equal(seen!.merged[0].positions, released);
  assert.deepEqual(seen!.merged[0].color, [1, 0, 0, 1]);
  assert.equal(seen!.filtered[0].positions, released);
});

it('shows the replacement after a completion recolour swaps the mesh array (#7021)', () => {
  startLoad('m');
  render(<Probe />);
  const a = mesh(), b = mesh();
  append('m', [a, b]);
  act(() => { useViewerStore.getState().updateMeshColors(new Map([[b.expressId, [0, 1, 0, 1]]])); });
  assert.deepEqual(ids(seen!.merged), [a.expressId, b.expressId]);
  assert.deepEqual(seen!.merged[1].color, [0, 1, 0, 1]);
  assert.deepEqual(seen!.filtered[1].color, [0, 1, 0, 1]);
  assert.equal(seen!.merged[1].modelIndex, 0);
});

it('stamps each model its own index once a second model joins (#7021)', () => {
  startLoad('a');
  render(<Probe />);
  append('a', [mesh(), mesh()]);
  startLoad('b');
  append('b', [mesh()]);
  append('b', [mesh()]);
  const byIndex = seen!.merged.map((m) => m.modelIndex);
  assert.deepEqual(byIndex, [0, 0, 1, 1]);
  assert.equal(seen!.filtered.length, 4);
});

/**
 * The regression guard (#7021): a streamed append must cost the viewport work
 * in the appended meshes only. Before the fix every append copied every mesh
 * accumulated so far (`viewer.modelIndexRespread`), which gave the merged
 * array a new identity, so the filter (`viewer.filterScan`) and the appearance
 * list (`viewer.appearanceSource`) rescanned everything too.
 */
it('costs O(appended meshes) per streamed append on a single model (#7021)', () => {
  perfCounters.enable();
  const read = () => perfCounters.read();
  const delta = (after: Record<string, number>, before: Record<string, number>, key: string) => (after[key] ?? 0) - (before[key] ?? 0);
  startLoad('m');
  render(<Probe />);
  append('m', [mesh(), mesh()]);
  const mergedArray = seen!.merged, appearanceArray = seen!.appearance;
  let total = 2;
  for (const size of [3, 5, 8, 13, 21]) {
    const before = read();
    append('m', Array.from({ length: size }, () => mesh()));
    total += size;
    const after = read();
    assert.equal(seen!.merged.length, total);
    assert.equal(delta(after, before, 'viewer.modelIndexRespread.meshes'), 0, 'no mesh is copied to stamp its model index');
    assert.equal(delta(after, before, 'viewer.modelIndexStamp.meshes'), size, 'only the appended meshes are stamped');
    assert.equal(delta(after, before, 'viewer.filterScan.meshes'), size, 'the filter visits only the appended meshes');
    assert.equal(delta(after, before, 'viewer.appearanceSource.meshes'), 0, 'the appearance list is not rebuilt');
    assert.equal(seen!.merged, mergedArray, 'the merged array keeps its identity');
    assert.equal(seen!.appearance, appearanceArray, 'the appearance list keeps its identity');
  }
});
