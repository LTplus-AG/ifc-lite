/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The RTC re-base moves inline cloud origins with the meshes (#10029), so the
 * pre-alignment snapshot has to carry them too. Otherwise a rollback (the stale
 * realign transaction in `federationRealign.ts`) puts the meshes and frame back
 * and leaves the cloud in the anchor frame, and the next re-base moves it twice.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { CoordinateInfo, GeometryResult, MeshData, PointCloudAsset } from '@ifc-lite/geometry';
import { convergeGeometryOntoRtcAnchor } from '@ifc-lite/geometry/rtc-rebase';
import { ifcToViewerAxes } from '@ifc-lite/geometry/world-frame';
import { capturePreAlignment, restorePreAlignment } from './federationPreAlignment.js';

const LV95 = { x: 2_600_123.456, y: 1_200_654.321, z: 432.1 };

function geometry(): GeometryResult {
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
  const coordinateInfo: CoordinateInfo = { originShift: { x: 0, y: 0, z: 0 }, originalBounds: box, shiftedBounds: box, hasLargeCoordinates: false };
  const mesh: MeshData = { expressId: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1], origin: [10, 0, 0] };
  const cloud: PointCloudAsset = { expressId: 2, chunk: { pointCount: 1, positions: new Float32Array([10, 0, 0]),
    bbox: { min: [10, 0, 0], max: [10, 0, 0] } } };
  return { meshes: [mesh], pointClouds: [cloud], totalTriangles: 1, totalVertices: 3, coordinateInfo };
}

it('a rollback restores inline cloud origins with the meshes, so a second re-base moves the cloud once (#10029)', () => {
  const g = geometry();
  const saved = capturePreAlignment(g);
  convergeGeometryOntoRtcAnchor([g], LV95);
  restorePreAlignment(g, saved);
  assert.deepEqual(g.meshes[0].origin, [10, 0, 0]);
  assert.equal(g.pointClouds![0].origin, undefined, 'the cloud is back in the raw frame with its mesh');

  convergeGeometryOntoRtcAnchor([g], LV95);
  const d = ifcToViewerAxes(LV95);
  assert.deepEqual(g.pointClouds![0].origin, [-d.x, -d.y, -d.z], 'moved once, not twice');
  assert.deepEqual(g.meshes[0].origin, [10 - d.x, -d.y, -d.z]);
});
