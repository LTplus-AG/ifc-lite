/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7021: what the viewport gets while one model streams in, through the real
 * store actions and the hook chain `ViewportContainer` runs (`modelIndices`
 * -> `useFederatedGeometry`). The first tests pin the OUTPUT: which meshes,
 * in which order, with which modelIndex, and that in-place edits to a store
 * mesh stay visible. The last one is the regression guard on the per-append
 * cost. The type filter and the appearance list downstream rescan from
 * scratch whenever this array changes identity, so a stable array is what
 * keeps them incremental.
 */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { act, useMemo } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import { perfCounters } from '@ifc-lite/load-trace';
import { useViewerStore, type FederatedModel } from '@/store';
import { modelIndices } from '@/lib/model-placement/model-indices.js';
import { carryReleasedMesh, meshGeometryCounts, hasMeshGeometryProvenance } from '@/lib/released-mesh-provenance.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { cleanup, render } from '@/test/render.js';
import { useFederatedGeometry } from './useFederatedGeometry.js';
import { useFilteredGeometry } from './useFilteredGeometry.js';
import { useAppearanceSourceGeometry } from './useAppearanceSourceGeometry.js';
import { placedMesh } from '@/lib/model-placement/placed-geometry.js';

const coordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  hasLargeCoordinates: false,
};

let seen: { merged: MeshData[]; filtered: MeshData[]; replacement: number; indices: ReadonlyMap<string, number> } | null = null;

function Probe() {
  const s = useViewerStore();
  const indices = useMemo(() => modelIndices(s.models), [s.models]);
  const merged = useFederatedGeometry(s.models, s.geometryResult, indices, s.geometryContentVersion);
  const filtered = useFilteredGeometry(merged, s.geometryContentVersion, s.typeVisibility, s.typeViewMode);
  seen = { merged: merged?.meshes ?? [], filtered: filtered.filteredGeometry ?? [],
    replacement: filtered.geometryReplacementVersion, indices };
  return null;
}

afterEach(() => {
  cleanup();
  useViewerStore.getState().clearAllModels();
  modelIndices(new Map());
  seen = null;
});

let nextId = 1;
function mesh(ifcType = 'IfcWall'): MeshData {
  const id = nextId++;
  return {
    expressId: id, ifcType, color: [0.5, 0.5, 0.5, 1],
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

it('CPU copy bookkeeping allows discarded wrappers and released arrays to be collected (#6584)', () => {
  execFileSync(process.execPath, ['--expose-gc', '--import', 'tsx', '--import', './src/test/vite-module-hooks.mjs',
    fileURLToPath(new URL('../../test/geometry-cpu-aliases-gc.ts', import.meta.url))], { timeout: 15_000 });
});

it('streams a single model into the viewport in order, with its model index (#7021)', () => {
  startLoad('m');
  render(<Probe />);
  const appended: MeshData[] = [];
  for (let batch = 0; batch < 6; batch++) {
    const part = [mesh(), mesh('IfcOpeningElement'), mesh('IfcSlab')];
    appended.push(...part);
    append('m', part);
    assert.deepEqual(ids(seen!.merged), ids(appended), `merged after batch ${batch}`);
    for (const m of seen!.merged) assert.equal(m.modelIndex, 0);
    // The viewport's mesh carries the store mesh's own buffers.
    assert.equal(seen!.merged.at(-1)!.positions, part.at(-1)!.positions);
  }
});

it('keeps in-place edits to a store mesh visible after the next write (#7021)', () => {
  startLoad('m');
  render(<Probe />);
  append('m', [mesh(), mesh()]);
  // releaseGeometryMemory, alignment restores and the loader's colour pass
  // reassign fields on the store's own mesh objects.
  const released = new Float32Array(0);
  const stored = useViewerStore.getState().models.get('m')!.geometryResult!.meshes[0];
  stored.positions = released;
  stored.color = [1, 0, 0, 1];
  append('m', [mesh()]);
  assert.equal(seen!.merged[0].positions, released);
  assert.deepEqual(seen!.merged[0].color, [1, 0, 0, 1]);
});

it('shows the replacement after a completion recolour swaps the mesh array (#7021)', () => {
  startLoad('m');
  render(<Probe />);
  const a = mesh(), b = mesh();
  append('m', [a, b]);
  act(() => { useViewerStore.getState().updateMeshColors(new Map([[b.expressId, [0, 1, 0, 1]]])); });
  assert.deepEqual(ids(seen!.merged), [a.expressId, b.expressId]);
  assert.deepEqual(seen!.merged[1].color, [0, 1, 0, 1]);
  assert.equal(seen!.merged[1].modelIndex, 0);
  assert.equal(seen!.replacement, 0, 'completion recolouring uses the colour drain, not a geometry rebuild (#7047)');
});

it('stamps each model its own index once a second model joins (#7021)', () => {
  startLoad('a');
  render(<Probe />);
  append('a', [mesh(), mesh()]);
  startLoad('b');
  append('b', [mesh()]);
  append('b', [mesh()]);
  assert.deepEqual(seen!.merged.map((m) => m.modelIndex), [0, 0, 1, 1]);
});

/**
 * The regression guard (#7021): a streamed append must cost the viewport work
 * in the appended meshes only. Before the fix every append copied every mesh
 * accumulated so far (`viewer.modelIndexRespread`) into a new array, so the
 * filters and the appearance list downstream rescanned everything too.
 */
it('costs O(appended meshes) per streamed append on a single model (#7021)', () => {
  perfCounters.enable();
  const read = () => perfCounters.read();
  const delta = (after: Record<string, number>, before: Record<string, number>, key: string) => (after[key] ?? 0) - (before[key] ?? 0);
  startLoad('m');
  render(<Probe />);
  append('m', [mesh(), mesh()]);
  const mergedArray = seen!.merged, indexMap = seen!.indices;
  let total = 2;
  for (const size of [3, 5, 8, 13, 21]) {
    const before = read();
    append('m', Array.from({ length: size }, () => mesh()));
    total += size;
    const after = read();
    assert.equal(seen!.merged.length, total);
    assert.equal(delta(after, before, 'viewer.modelIndexRespread.meshes'), 0, 'no mesh is copied to stamp its model index');
    assert.equal(delta(after, before, 'viewer.modelIndexStamp.meshes'), size, 'only the appended meshes are stamped');
    assert.equal(delta(after, before, 'viewer.filterScan.meshes'), size, 'the replacement detector never rescans the old prefix (#7047)');
    assert.deepEqual(ids(seen!.filtered), ids(seen!.merged), 'all streamed occurrence meshes reach the viewport filter');
    assert.equal(seen!.replacement, 0, 'streaming appends do not request replacement uploads');
    assert.equal(seen!.merged, mergedArray, 'the merged array keeps its identity');
    assert.equal(seen!.indices, indexMap, 'the model-index map keeps its identity');
  }
});

it('restamps a model that is removed and added back under a new index (#7021 review)', () => {
  startLoad('a');
  render(<Probe />);
  append('a', [mesh()]);
  startLoad('b');
  append('b', [mesh()]);
  const a = useViewerStore.getState().models.get('a')!;
  act(() => { useViewerStore.getState().removeModel('a'); });
  assert.deepEqual(seen!.merged.map((m) => m.modelIndex), [1]);
  act(() => { useViewerStore.getState().upsertModel(a); });
  const index = seen!.indices.get('a');
  assert.notEqual(index, 0, 'the allocator never reuses a removed model\'s index');
  assert.deepEqual(seen!.merged.map((m) => m.modelIndex).sort(), [1, index].sort());
});

// #6584: canonical CPU release must also empty spread wrappers retained by the
// actual viewport filter, without making the peer or fresh append unuploadable.
for (const appendAfterRelease of [false, true]) it(`releases federated aliases${appendAfterRelease ? ' across batched appends' : ''} (#6584)`, () => {
  startLoad('a');
  render(<Probe />);
  const first = mesh(); append('a', [first]);
  startLoad('b');
  const peer = mesh(); append('b', [peer]);
  act(() => { useViewerStore.getState().setActiveModel('a'); useViewerStore.setState({ boundedGeometryMode: true }); });
  assert.equal(useViewerStore.getState().activeModelId, 'a');
  for (let attempt = 0; attempt < (appendAfterRelease ? 2 : 1); attempt++) {
    const retained = seen!.merged.slice(), filtered = seen!.filtered.slice();
    const prefix = ids(retained), suffix = mesh();
    const source = useViewerStore.getState().models.get('a')!.geometryResult!.meshes;
    act(() => {
      useViewerStore.getState().releaseGeometryMemory();
      if (appendAfterRelease) useViewerStore.getState().appendGeometryBatch('a', [suffix], coordinateInfo);
    });
    for (const alias of [...retained, ...filtered].filter(m => m.modelIndex === 0)) {
      assert.equal(alias.positions.length, 0, 'a retained viewport alias must not pin released CPU buffers');
      assert.equal(alias.normals.length, 0); assert.equal(alias.indices.length, 0);
      assert.equal(hasMeshGeometryProvenance(alias), true);
      assert.deepEqual(meshGeometryCounts(alias), { vertices: 3, triangles: 1 });
    }
    assert.equal(seen!.merged.find(m => m.expressId === peer.expressId)!.positions, peer.positions);
    assert.equal(peer.positions.length, 9, 'unreleased peer remains uploadable');
    assert.equal(useViewerStore.getState().models.get('a')!.geometryResult!.meshes, source);
    assert.deepEqual(ids(seen!.merged).slice(0, prefix.length), prefix, 'the GPU upload cursor keeps its global prefix');
    if (appendAfterRelease) assert.equal(seen!.merged.at(-1)!.positions, suffix.positions);
    assert.equal(useViewerStore.getState().geometryContentVersion, 0, 'CPU release must not request an empty GPU reupload');
  }
});

for (const replacement of ['colors', 'peer', 'clear'] as const) it(`empties federated aliases before batched ${replacement} replacement (#6584)`, () => {
  startLoad('a'); render(<Probe />);
  const first = mesh(); append('a', [first]);
  startLoad('b'); const peer = mesh(); append('b', [peer]);
  act(() => { useViewerStore.getState().setActiveModel('a'); useViewerStore.setState({ boundedGeometryMode: true }); });
  const retained = seen!.merged.slice(), filtered = seen!.filtered.slice();
  act(() => {
    useViewerStore.getState().releaseGeometryMemory();
    if (replacement === 'clear') useViewerStore.getState().clearAllModels();
    else if (replacement === 'colors') useViewerStore.getState().updateMeshColors(new Map([[first.expressId, [0, 1, 0, 1]]]));
    else {
      const state = useViewerStore.getState(), model = state.models.get('b')!, fresh = mesh();
      useViewerStore.setState({ models: new Map(state.models).set('b', { ...model, geometryResult: { ...model.geometryResult!, meshes: [fresh] } }) });
    }
  });
  for (const alias of [...retained, ...filtered].filter(m => m.modelIndex === 0)) {
    assert.equal(alias.positions.length, 0); assert.equal(alias.normals.length, 0); assert.equal(alias.indices.length, 0);
    assert.equal(hasMeshGeometryProvenance(alias), true);
    assert.deepEqual(meshGeometryCounts(alias), { vertices: 3, triangles: 1 });
  }
  assert.equal(retained.find(m => m.modelIndex === 1)!.positions.length, 9, 'unreleased retained peer stays intact');
});

// Retired consumers can outlive an immutable colour replacement. Release must
// reach those aliases too; observing only the current source array is too late.
it('releases previously retained federation wrappers after an earlier recolour (#6584)', () => {
  startLoad('a'); render(<Probe />); const first = mesh(); append('a', [first]);
  startLoad('b'); const peer = mesh(); append('b', [peer]);
  act(() => { useViewerStore.getState().setActiveModel('a'); useViewerStore.setState({ boundedGeometryMode: true }); });
  const retained = seen!.merged.find(m => m.expressId === first.expressId)!;
  act(() => useViewerStore.getState().updateMeshColors(new Map([[first.expressId, [0, 1, 0, 1]]])));
  assert.equal(retained.positions.length, 9, 'recolour itself retains uploadable geometry');
  act(() => useViewerStore.getState().releaseGeometryMemory());
  assert.equal(retained.positions.length, 0, 'a preceding immutable replacement cannot strand a retained alias');
  assert.equal(retained.normals.length, 0); assert.equal(retained.indices.length, 0);
  assert.equal(peer.positions.length, 9);
});

it('canonical release empties shared copy fields and preserves independent updates (#6584)', () => {
  startLoad('a'); render(<Probe />);
  const first = mesh(); first.geometryItemId = first.expressId;
  first.appearanceSource = { kind: 'canonical-item', indices: first.indices, sourceIndices: first.indices };
  append('a', [first]);
  const source = useViewerStore.getState().models.get('a')!.geometryResult!.meshes[0];
  const shared = carryReleasedMesh(source, { ...source });
  const fresh = mesh();
  const independent = carryReleasedMesh(source, { ...source, positions: fresh.positions, normals: fresh.normals,
    indices: fresh.indices, appearanceSource: { kind: 'canonical-item', indices: fresh.indices, sourceIndices: fresh.indices } });
  const partial = carryReleasedMesh(source, { ...source });
  const updatedPositions = new Float32Array(18); updatedPositions.set(source.positions);
  partial.positions = updatedPositions;
  const updatedAppearance = { kind: 'canonical-item' as const, indices: new Uint32Array(source.indices), sourceIndices: new Uint32Array(source.indices) };
  partial.appearanceSource = updatedAppearance;
  act(() => { useViewerStore.setState({ boundedGeometryMode: true }); useViewerStore.getState().releaseGeometryMemory(); });
  assert.equal(shared.positions.length, 0); assert.equal(shared.normals.length, 0); assert.equal(shared.indices.length, 0);
  assert.equal(shared.appearanceSource, undefined);
  assert.equal(partial.positions, updatedPositions); assert.equal(partial.positions.length, 18);
  assert.equal(partial.normals.length, 0); assert.equal(partial.indices.length, 0);
  assert.equal(partial.appearanceSource, updatedAppearance, 'a replaced appearance buffer is independently owned');
  assert.equal(hasMeshGeometryProvenance(partial), true);
  assert.deepEqual(meshGeometryCounts(partial), { triangles: 1, vertices: 6 }, 'released indices retain triangle counts while independent positions provide live vertex counts');
  act(() => useViewerStore.getState().releaseGeometryMemory());
  assert.deepEqual(meshGeometryCounts(partial), { triangles: 1, vertices: 6 }, 'repeated release cannot overwrite a retained field count with zero');
  assert.equal(independent.positions, fresh.positions); assert.equal(independent.normals, fresh.normals);
  assert.equal(independent.indices, fresh.indices); assert.equal(independent.indices.length, 3);
  assert.equal(independent.appearanceSource!.sourceIndices, fresh.indices);
  for (const released of [source, shared]) {
    assert.equal(hasMeshGeometryProvenance(released), true);
    assert.deepEqual(meshGeometryCounts(released), { triangles: 1, vertices: 3 });
  }
});


it('replacement geometry does not inherit counts for legitimately empty fields (#6584)', () => {
  startLoad('a'); render(<Probe />);
  append('a', [mesh()]);
  const source = useViewerStore.getState().models.get('a')!.geometryResult!.meshes[0];
  act(() => { useViewerStore.setState({ boundedGeometryMode: true }); useViewerStore.getState().releaseGeometryMemory(); });
  assert.deepEqual(meshGeometryCounts(source), { triangles: 1, vertices: 3 });
  const verticesOnly = carryReleasedMesh(source, { ...source, positions: new Float32Array(18), indices: new Uint32Array(0) });
  assert.deepEqual(meshGeometryCounts(verticesOnly), { triangles: 0, vertices: 6 });
  const indicesOnly = carryReleasedMesh(source, { ...source, positions: new Float32Array(0), indices: new Uint32Array([0, 1, 2, 2, 3, 0]) });
  assert.deepEqual(meshGeometryCounts(indicesOnly), { triangles: 2, vertices: 0 });
  const emptyReplacement = carryReleasedMesh(source, { ...source, positions: new Float32Array(0), indices: new Uint32Array(0) });
  assert.deepEqual(meshGeometryCounts(emptyReplacement), { triangles: 0, vertices: 0 });
});


it('colour reset preserves release ownership of retained viewport copies (#6584)', () => {
  startLoad('a'); render(<Probe />); append('a', [mesh()]);
  startLoad('b'); append('b', [mesh()]);
  act(() => useViewerStore.getState().setActiveModel('a'));
  const retained = seen!.merged.find(mesh => mesh.modelIndex === seen!.indices.get('a'))!;
  act(() => useViewerStore.getState().updateMeshColors(new Map([[retained.expressId, [0, 1, 0, 1]]]), { override: true }));
  act(() => useViewerStore.getState().resetMeshColors());
  act(() => { useViewerStore.setState({ boundedGeometryMode: true }); useViewerStore.getState().releaseGeometryMemory(); });
  assert.equal(retained.positions.length, 0);
  assert.equal(retained.indices.length, 0);
  assert.deepEqual(meshGeometryCounts(retained), { triangles: 1, vertices: 3 });
});

it('appearance-source wrappers follow the canonical active-model CPU release (#6584)', () => {
  startLoad('a'); append('a', [mesh()]);
  startLoad('b'); append('b', [mesh()]);
  let appearances: MeshData[] = [];
  function AppearanceProbe() {
    const state = useViewerStore();
    const indices = useMemo(() => modelIndices(state.models), [state.models]);
    appearances = useAppearanceSourceGeometry(state.models, indices, state.geometryContentVersion);
    return null;
  }
  render(<AppearanceProbe />);
  const bIndex = modelIndices(useViewerStore.getState().models).get('b');
  const retained = appearances.find(mesh => mesh.modelIndex === bIndex)!;
  assert.equal(retained.positions.length, 9);
  act(() => { useViewerStore.getState().setActiveModel('b'); useViewerStore.setState({ boundedGeometryMode: true }); useViewerStore.getState().releaseGeometryMemory(); });
  assert.equal(retained.positions.length, 0);
  assert.equal(retained.indices.length, 0);
});

it('placed shallow copies retain placement while canonical release removes shared CPU bytes (#6584)', () => {
  startLoad('a'); render(<Probe />); append('a', [mesh()]);
  const source = useViewerStore.getState().models.get('a')!.geometryResult!.meshes[0];
  const placed = placedMesh(source, [2, 3, 4]);
  assert.deepEqual(placed.origin, [2, 4, -3]);
  assert.equal(placed.positions, source.positions);
  act(() => { useViewerStore.setState({ boundedGeometryMode: true }); useViewerStore.getState().releaseGeometryMemory(); });
  assert.equal(placed.positions.length, 0); assert.equal(placed.indices.length, 0);
  assert.deepEqual(placed.origin, [2, 4, -3]);
  assert.equal(hasMeshGeometryProvenance(placed), true);
  assert.deepEqual(meshGeometryCounts(placed), { triangles: 1, vertices: 3 });
});
