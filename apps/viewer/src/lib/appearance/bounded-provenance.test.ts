/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture.js';

afterEach(() => useViewerStore.setState({ models: new Map(), activeModelId: null,
  geometryResult: null, boundedGeometryMode: false }));

it('bounded memory release drops canonical provenance instead of retaining freed topology (#4243)', () => {
  const indices = new Uint32Array([0, 1, 2]);
  const mesh: MeshData = { expressId: 10, geometryItemId: 20,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices,
    color: [1, 1, 1, 1],
    appearanceSource: { kind: 'canonical-item', indices, sourceIndices: indices,
      cornerIndices: new Uint32Array([0, 1, 2]) },
  };
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } };
  const geometry: GeometryResult = { meshes: [mesh], totalVertices: 3, totalTriangles: 1,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } };
  const model = { ...fixtureModel('bounded'), geometryResult: geometry };
  useViewerStore.setState({ models: new Map([[model.id, model]]), activeModelId: model.id,
    geometryResult: geometry, boundedGeometryMode: false });
  useViewerStore.getState().releaseGeometryMemory();
  assert.strictEqual(mesh.indices, indices, 'ordinary mode retains editable CPU geometry');
  assert.ok(mesh.appearanceSource);
  useViewerStore.setState({ boundedGeometryMode: true });
  useViewerStore.getState().releaseGeometryMemory();
  assert.equal(mesh.positions.byteLength + mesh.normals.byteLength + mesh.indices.byteLength, 0);
  assert.equal(mesh.appearanceSource, undefined, 'provenance cannot keep indices or corner remaps alive');
  assert.strictEqual(useViewerStore.getState().geometryResult?.meshes[0], mesh);
  assert.strictEqual(useViewerStore.getState().models.get(model.id)?.geometryResult?.meshes[0], mesh);
});
