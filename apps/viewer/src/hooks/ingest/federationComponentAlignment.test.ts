/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { CoordinateInfo, GeometryResult, MeshData, ModelSpatialReference } from '@ifc-lite/geometry';
import { alignGeometryToReference, type ModelSpatialPlacement } from './federationAlign.js';
import { alignLandXmlComponent } from './federationComponentAlignment.js';

const coordinateInfo: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  hasLargeCoordinates: false,
};

function placement(horizontal: string, eastings: number): ModelSpatialPlacement {
  const spatialReference: ModelSpatialReference = {
    source: { axes: ['east', 'up', 'south'], horizontalUnitToMetres: 1, verticalUnitToMetres: 1 },
    horizontal: { id: horizontal, provenance: { source: 'test' } },
    vertical: { id: 'EPSG:5729', provenance: { source: 'test' } },
    localToProjected: {
      kind: 'local-projected-affine', eastings, northings: 5_000_000, orthogonalHeight: 0,
      xAxisAbscissa: 1, xAxisOrdinate: 0, scaleX: 1, scaleY: 1, scaleZ: 1,
    },
    confidence: 'declared',
  };
  return { spatialReference, coordinateInfo };
}

function mesh(): MeshData {
  return {
    expressId: 1,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]), color: [0.42, 0.62, 0.32, 1], origin: [0, 0, 0],
  };
}

it('uses the canonical nonlinear cross-CRS result for each streamed component (#5050)', async () => {
  const source = placement('EPSG:32632', 500_000);
  const reference = placement('EPSG:32633', 300_000);
  const aggregateMesh = mesh();
  const aggregate: GeometryResult = {
    meshes: [aggregateMesh], totalVertices: 3, totalTriangles: 1, coordinateInfo: structuredClone(coordinateInfo),
  };
  assert.equal(await alignGeometryToReference(aggregate, source, reference), 'reprojected');

  const component = await alignLandXmlComponent(mesh(), coordinateInfo, source, reference);
  assert.equal(component.status, 'reprojected');
  assert.deepEqual(component.mesh.positions, aggregateMesh.positions);
  assert.deepEqual(component.mesh.origin, aggregateMesh.origin);
  assert.deepEqual(component.coordinateInfo.originalBounds, aggregate.coordinateInfo.originalBounds);
});

/** The same placement with its vertical datum dropped, or replaced. */
function withVertical(placementValue: ModelSpatialPlacement, vertical: string | null): ModelSpatialPlacement {
  const { vertical: _dropped, ...rest } = placementValue.spatialReference;
  return {
    ...placementValue,
    spatialReference: vertical === null ? rest : { ...rest, vertical: { id: vertical } },
  };
}

function geometryOf(meshData: MeshData): GeometryResult {
  return { meshes: [meshData], totalVertices: 3, totalTriangles: 1, coordinateInfo: structuredClone(coordinateInfo) };
}

it('carries an unknown vertical datum only under the user\'s sharedVerticalDatum policy, same-CRS and cross-CRS alike', async () => {
  for (const [source, reference, aligned] of [
    [withVertical(placement('EPSG:32632', 500_000), null), withVertical(placement('EPSG:32632', 499_000), null), 'same-crs'],
    [withVertical(placement('EPSG:32632', 500_000), null), placement('EPSG:32633', 300_000), 'reprojected'],
    [placement('EPSG:32632', 500_000), withVertical(placement('EPSG:32633', 300_000), null), 'reprojected'],
  ] as const) {
    // Fail-closed by default: nothing moves.
    const refused = mesh();
    assert.equal(await alignGeometryToReference(geometryOf(refused), source, reference), 'failed');
    assert.deepEqual(refused.positions, mesh().positions);

    const assumed = await alignLandXmlComponent(mesh(), coordinateInfo, source, reference, 'assume-compatible');
    assert.equal(assumed.status, aligned);
    // Heights are placed as authored: the up axis of every vertex is unchanged.
    const origin = assumed.mesh.origin ?? [0, 0, 0];
    const authored = mesh().positions;
    for (let index = 1; index < 9; index += 3) {
      assert.ok(Math.abs(assumed.mesh.positions[index]! + origin[1] - authored[index]!) < 1e-6, `${aligned}: ${assumed.mesh.positions}`);
    }
  }
});

it('never treats two declared, different vertical datums as one, whatever the policy', async () => {
  const source = placement('EPSG:32632', 500_000);
  const reference = withVertical(placement('EPSG:32632', 499_000), 'EPSG:5783');
  assert.equal((await alignLandXmlComponent(mesh(), coordinateInfo, source, reference, 'assume-compatible')).status, 'failed');
  const crossReference = withVertical(placement('EPSG:32633', 300_000), 'EPSG:5783');
  assert.equal((await alignLandXmlComponent(mesh(), coordinateInfo, source, crossReference, 'assume-compatible')).status, 'failed');
});
