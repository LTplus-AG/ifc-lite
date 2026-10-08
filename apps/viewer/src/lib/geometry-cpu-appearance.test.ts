/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData, GeometryResult } from '@ifc-lite/geometry';
import { appearanceSourceTriangle, expandAppearanceCorners } from '@ifc-lite/renderer';
import { splitMeshForStreaming } from '../../../../packages/renderer/src/scene-stream-split.js';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture.js';
import { carryReleasedMesh, meshGeometryCounts, hasMeshGeometryProvenance } from './released-mesh-provenance.js';
import { capturePreAlignment, restorePreAlignment } from '@/hooks/ingest/federationPreAlignment.js';
import { placedMesh } from './model-placement/placed-geometry.js';

afterEach(() => useViewerStore.getState().clearAllModels());

function seed(): MeshData {
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
  const source: MeshData = { expressId: 10, geometryItemId: 20, color: [1, 1, 1, 1],
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), indices,
    appearanceSource: { kind: 'canonical-item', indices, sourceIndices: indices } };
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } };
  const geometry: GeometryResult = { meshes: [source], totalVertices: 4, totalTriangles: 2,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } };
  const model = { ...fixtureModel('cpu-appearance'), geometryResult: geometry };
  useViewerStore.setState({ models: new Map([[model.id, model]]), activeModelId: model.id,
    geometryResult: geometry, boundedGeometryMode: true });
  return source;
}

it('canonical pre-alignment restore releases prior registered allocations and preserves independent alias fields (#6584)', () => {
  const source = seed();
  const geometry = useViewerStore.getState().geometryResult!;
  const snapshot = capturePreAlignment(geometry);
  const retained = placedMesh(source, [1, 0, 0]);
  const partial = carryReleasedMesh(source, { ...source });
  const independentPositions = source.positions.slice();
  partial.positions = independentPositions;
  const oldPositions = retained.positions, oldNormals = retained.normals;
  restorePreAlignment(geometry, snapshot);
  assert.notEqual(source.positions, oldPositions, 'actual frame restore replaces the source allocation');
  assert.notEqual(source.normals, oldNormals);
  useViewerStore.getState().releaseGeometryMemory();
  assert.equal(source.positions.byteLength, 0);
  assert.equal(retained.positions.byteLength, 0, 'prior source positions cannot remain pinned by a registered copy');
  assert.equal(retained.normals.byteLength, 0, 'prior source normals cannot remain pinned by a registered copy');
  assert.equal(retained.indices.byteLength, 0);
  assert.equal(partial.positions, independentPositions, 'unrelated replacement allocation remains live');
  assert.deepEqual(meshGeometryCounts(retained), { triangles: 2, vertices: 4 });
  assert.deepEqual(meshGeometryCounts(partial), { triangles: 2, vertices: 4 });
  assert.deepEqual(retained.origin, [1, 0, 0]);
  assert.equal(hasMeshGeometryProvenance(retained), true);
});

it('canonical stream fragments release appearance-only aliases while retaining their independent topology (#6584)', () => {
  const source = seed();
  // Real split outputs passed through the canonical registered-copy seam.
  // This does not assert automatic renderer-fragment registration; Scene owns
  // its releaseGeometryData buckets separately.
  const fragments = splitMeshForStreaming(source, 3, 1000).map(fragment => carryReleasedMesh(source, fragment));
  assert.equal(fragments.length, 2);
  assert.deepEqual(fragments.map(fragment => appearanceSourceTriangle(fragment, 0)), [0, 1]);
  const live = fragments.map(fragment => ({ positions: fragment.positions, normals: fragment.normals,
    indices: fragment.indices, cornerIndices: fragment.appearanceSource!.cornerIndices }));
  assert.ok(fragments.every(fragment => fragment.positions !== source.positions && fragment.indices !== source.indices));
  useViewerStore.getState().releaseGeometryMemory();
  for (const [index, fragment] of fragments.entries()) {
    assert.equal(fragment.appearanceSource!.sourceIndices.byteLength, 0, 'a separate provenance object cannot pin the released full surface');
    assert.equal(fragment.positions, live[index].positions);
    assert.equal(fragment.normals, live[index].normals);
    assert.equal(fragment.indices, live[index].indices);
    assert.equal(fragment.appearanceSource!.indices, live[index].indices, 'independent topology identity fence survives');
    assert.equal(fragment.appearanceSource!.cornerIndices, live[index].cornerIndices, 'independent corner remapping survives');
    assert.equal(appearanceSourceTriangle(fragment, 0), undefined, 'released source topology is no longer editable provenance');
    assert.deepEqual(meshGeometryCounts(fragment), { triangles: 1, vertices: 3 });
  }
  assert.equal(source.appearanceSource, undefined);
  assert.deepEqual(meshGeometryCounts(source), { triangles: 2, vertices: 4 });
  assert.equal(hasMeshGeometryProvenance(source), true);
});

it('separately spread appearance metadata clears only fields sharing a released backing buffer (#6584)', () => {
  const source = seed();
  const copied = carryReleasedMesh(source, { ...source, appearanceSource: { ...source.appearanceSource! } });
  const independentSource = source.indices.slice(), independentCorners = new Uint32Array([0, 1, 2, 3, 4, 5]);
  const partial = carryReleasedMesh(source, { ...source, appearanceSource: { ...source.appearanceSource!,
    indices: source.indices.subarray(), sourceIndices: independentSource, cornerIndices: independentCorners } });
  useViewerStore.getState().releaseGeometryMemory();
  assert.equal(copied.appearanceSource, undefined, 'fully shared provenance is dropped even when its object was spread');
  assert.equal(partial.appearanceSource!.indices.buffer.byteLength, 0, 'a distinct view cannot retain the source allocation');
  assert.equal(partial.appearanceSource!.sourceIndices, independentSource);
  assert.equal(partial.appearanceSource!.cornerIndices, independentCorners);
  assert.deepEqual(meshGeometryCounts(partial), { triangles: 2, vertices: 4 });
});

it('an appearance-only zero-length view releases its populated backing allocation (#6584)', () => {
  const source = seed();
  const fragment = splitMeshForStreaming(source, 3, 1000)[0];
  const copy = carryReleasedMesh(source, { ...fragment, appearanceSource: { ...fragment.appearanceSource!,
    sourceIndices: source.indices.subarray(0, 0) } });
  const indices = copy.indices, corners = copy.appearanceSource!.cornerIndices;
  const counts = meshGeometryCounts(copy);
  assert.equal(copy.appearanceSource!.sourceIndices.byteLength, 0);
  assert.ok(copy.appearanceSource!.sourceIndices.buffer.byteLength > 0);
  useViewerStore.getState().releaseGeometryMemory();
  assert.equal(copy.appearanceSource!.sourceIndices.buffer.byteLength, 0, 'a zero-length view cannot pin the released allocation');
  assert.equal(copy.appearanceSource!.indices, indices);
  assert.equal(copy.appearanceSource!.cornerIndices, corners);
  assert.deepEqual(meshGeometryCounts(copy), counts);
});

it('canonical appearance expansion preserves independent geometry and invalidates a released shared corner map (#6584)', () => {
  const source = seed();
  source.appearanceSource!.cornerIndices = new Uint32Array([0, 1, 2, 3, 4, 5]);
  const expanded = carryReleasedMesh(source, expandAppearanceCorners(source, source.indices,
    [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], source.indices.slice(),
    Array.from({ length: 18 }, (_, index) => index % 3 === 2 ? 1 : 0), 4));
  const positions = expanded.positions, normals = expanded.normals, indices = expanded.indices;
  const sourceIndices = expanded.appearanceSource!.sourceIndices;
  assert.deepEqual([appearanceSourceTriangle(expanded, 0), appearanceSourceTriangle(expanded, 1)], [0, 1]);
  useViewerStore.getState().releaseGeometryMemory();
  assert.equal(expanded.positions, positions); assert.equal(expanded.normals, normals); assert.equal(expanded.indices, indices);
  assert.equal(expanded.appearanceSource!.sourceIndices, sourceIndices);
  assert.equal(expanded.appearanceSource!.cornerIndices!.buffer.byteLength, 0, 'shared map allocation is released');
  assert.equal(appearanceSourceTriangle(expanded, 0), undefined, 'an empty fence must not become an implicit identity mapping');
  assert.deepEqual(meshGeometryCounts(expanded), { triangles: 2, vertices: 6 });
});
