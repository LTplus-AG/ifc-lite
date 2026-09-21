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
