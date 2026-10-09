/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, useMemo } from 'react';
import type { MeshData, GeometryResult } from '@ifc-lite/geometry';
import { diffCounters, perfCounters } from '@ifc-lite/load-trace';
import { useViewerStore } from '@/store';
import { modelIndices } from '@/lib/model-placement/model-indices.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { cleanup, render } from '@/test/render.js';
import { useAppearanceSourceGeometry } from './useAppearanceSourceGeometry.js';

let sources: MeshData[] = [];
let indices: ReadonlyMap<string, number> = new Map();
function Probe() {
  const models = useViewerStore(state => state.models);
  const version = useViewerStore(state => state.geometryContentVersion);
  indices = useMemo(() => modelIndices(models), [models]);
  sources = useAppearanceSourceGeometry(models, indices, version);
  return <output>{sources.map(mesh => `${mesh.modelIndex}:${mesh.expressId}`).join(',')}</output>;
}

// A stated order/ownership invariant over two independent triangles. Real
// produced IFC meshes are exercised separately by the mounted fixture replay.
function mesh(id: number): MeshData {
  return { expressId: id, geometryItemId: id + 100, color: [0.5, 0.5, 0.5, 1],
    positions: new Float32Array([id, 0, 0, id + 1, 0, 0, id, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) };
}
function geometry(meshes: MeshData[]): GeometryResult {
  return { meshes, totalVertices: meshes.length * 3, totalTriangles: meshes.length,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 1, z: 1 } },
      hasLargeCoordinates: false } };
}
function mount() {
  act(() => {
    useViewerStore.getState().upsertModel({ ...fixtureModel('a'), geometryResult: geometry([mesh(1), mesh(2)]) });
    useViewerStore.getState().upsertModel({ ...fixtureModel('b'), geometryResult: geometry([mesh(3)]) });
  });
  return render(<Probe />);
}

afterEach(() => {
  cleanup(); useViewerStore.getState().clearAllModels(); modelIndices(new Map());
  sources = []; indices = new Map();
});

it('includes hidden-model appearance without repeating unchanged mesh work (#6537 / #7021)', () => {
  perfCounters.enable();
  const ui = mount(), before = perfCounters.read(), original = sources;
  act(() => useViewerStore.getState().setModelVisibility('b', false));
  assert.equal(ui.textContent, '0:1,0:2,1:3', 'hidden model remains an appearance source');
  act(() => useViewerStore.getState().setModelVisibility('b', true));
  assert.equal(ui.textContent, '0:1,0:2,1:3');
  const delta = diffCounters(perfCounters.read(), before);
  assert.equal(delta['viewer.appearanceSource.meshes'] ?? 0, 0, 'visibility is not source replacement');
  assert.equal(sources, original, 'unchanged sources keep the existing combined list');
});

it('preserves model order when earlier and later models append (#6537)', () => {
  const ui = mount();
  act(() => useViewerStore.getState().appendGeometryBatch('a', [mesh(4), mesh(5)]));
  assert.equal(ui.textContent, '0:1,0:2,0:4,0:5,1:3');
  act(() => useViewerStore.getState().appendGeometryBatch('b', [mesh(6)]));
  assert.equal(ui.textContent, '0:1,0:2,0:4,0:5,1:3,1:6');
  act(() => useViewerStore.getState().appendGeometryBatch('a', [mesh(7)]));
  assert.equal(ui.textContent, '0:1,0:2,0:4,0:5,0:7,1:3,1:6');
});

it('adopts immutable colour replacement and keeps the peer geometry intact (#6537 / #4451)', () => {
  const ui = mount(), old = sources;
  const peerPositions = sources[2].positions;
  act(() => useViewerStore.getState().updateMeshColors(new Map([[1, [1, 0, 0, 1]]])));
  assert.notEqual(sources, old, 'an immutable source replacement rebuilds the list');
  assert.deepEqual(sources[0].color, [1, 0, 0, 1]);
  assert.deepEqual(sources[1].color, [0.5, 0.5, 0.5, 1]);
  assert.equal(sources[2].positions, peerPositions);
  assert.equal(ui.textContent, '0:1,0:2,1:3');
});

it('uses current model indices after removal/readdition and input reordering (#6537)', () => {
  const ui = mount(), a = useViewerStore.getState().models.get('a')!;
  act(() => useViewerStore.getState().removeModel('a'));
  assert.equal(ui.textContent, '1:3');
  act(() => useViewerStore.getState().upsertModel(a));
  const newIndex = indices.get('a');
  assert.ok(newIndex !== undefined && newIndex !== 0, 'removed renderer ownership is not reused');
  assert.equal(ui.textContent, `1:3,${newIndex}:1,${newIndex}:2`);
  const state = useViewerStore.getState();
  act(() => useViewerStore.setState({ models: new Map([
    ['a', state.models.get('a')!], ['b', state.models.get('b')!],
  ]) }));
  assert.equal(ui.textContent, `${newIndex}:1,${newIndex}:2,1:3`);
});

it('preserves canonical CPU release for a retained appearance list (#6537 / #6584)', () => {
  mount();
  const retained = sources.slice(), peerPositions = retained[2].positions;
  act(() => {
    useViewerStore.getState().setActiveModel('a');
    useViewerStore.setState({ boundedGeometryMode: true });
    useViewerStore.getState().releaseGeometryMemory();
  });
  for (const mesh of retained.slice(0, 2)) {
    assert.equal(mesh.positions.byteLength, 0);
    assert.equal(mesh.normals.byteLength, 0);
    assert.equal(mesh.indices.byteLength, 0);
  }
  assert.equal(retained[2].positions, peerPositions);
  assert.equal(retained[2].indices.length, 3, 'independent peer stays uploadable');
  act(() => useViewerStore.getState().appendGeometryBatch('a', [mesh(4)]));
  assert.deepEqual(sources.map(mesh => mesh.expressId), [1, 2, 4, 3]);
  assert.equal(sources[2].indices.length, 3, 'new source is uploadable after bounded release');
});
