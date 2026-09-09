/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { emptyPlacementState, importPlacements } from './state';
import { withInstancedMeshes } from '@/utils/instancedExport';

it('exports the known model placement when collab and loaded models overlap in global IDs (#4226)', () => {
  const geometry: GeometryResult = { meshes: [{ expressId: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] }],
    totalTriangles: 1, totalVertices: 3, coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } } } };
  const model = (id: string) => ({ ...fixtureModel(id, { idOffset: 0 }), maxExpressId: 100, geometryResult: geometry });
  useViewerStore.setState({ ...fixtureModels(model('room'), model('loaded')), modelPlacement: importPlacements(emptyPlacementState(),
    new Map([['room', { translation: [10, 0, 0], locked: false }], ['loaded', { translation: [100, 0, 0], locked: false }]])) });
  const first = withInstancedMeshes(geometry, { modelId: 'room', idOffset: 0, maxExpressId: 100 });
  const second = withInstancedMeshes(geometry, { modelId: 'loaded', idOffset: 0, maxExpressId: 100 });
  assert.equal(first.meshes[0].origin?.[0], 10);
  assert.equal(second.meshes[0].origin?.[0], 100);
  assert.equal(geometry.meshes[0].origin, undefined, 'neither export mutates the shared source');
});
