/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { PointCloudAsset } from '@ifc-lite/geometry';
import { applyAffineTransform, type AffineTransform3D } from './federationAlignAabb.js';
import { alignGeometryToReference, type ModelSpatialPlacement } from './federationAlign.js';
import { spatialReferenceFromIfc } from '../../lib/geo/ifc-spatial-reference.js';
import { stageInlineClouds } from './federationAlignClouds.js';

function cloud(origin?: [number, number, number]): PointCloudAsset {
  return { expressId: 90, origin, chunk: { pointCount: 4,
    positions: new Float32Array([0.01, 0.02, 0.03, -1.2345, 20.678, 100.01, NaN, NaN, NaN, 900, -400, 70]),
    bbox: { min: [-2, -400, 0], max: [900, 21, 101] } } };
}

it('inlined affine cloud staging is bit-identical to the closure at map scale (#10094, 3f)', () => {
  const transform: AffineTransform3D = { m00: 0.8, m01: -0.6, m02: 0.01, tx: 2600000.123,
    m10: 0.6, m11: 0.8, m12: 0.02, ty: 1200000.456,
    m20: 0.03, m21: -0.01, m22: 1.0001, tz: 400.789 };
  for (const origin of [undefined, [2600000, 1200000, 400] as [number, number, number]]) {
    const points = cloud(origin);
    const oldBounds: number[][] = [], newBounds: number[][] = [];
    const old = stageInlineClouds([points], (x, y, z) => applyAffineTransform(transform, x, y, z),
      (...p) => oldBounds.push(p));
    const actual = stageInlineClouds([points], transform, (...p) => newBounds.push(p));
    assert.ok(old && actual);
    assert.deepEqual(actual, old);
    assert.deepEqual(new Uint8Array(actual[0].chunk.positions.buffer), new Uint8Array(old[0].chunk.positions.buffer));
    assert.deepEqual(newBounds, oldBounds);
  }
});

it('counts valid cloud point attempts and failures, excluding origin and NaN holes (#10094, 3f)', () => {
  let attempts = 0, failures = 0;
  const staged = stageInlineClouds([cloud([2600000, 1200000, 400])],
    (x, y, z) => x >= 2600900 ? null : [x, y, z], () => undefined,
    (succeeded) => { attempts += 1; if (!succeeded) failures += 1; });
  assert.equal(staged, null);
  assert.equal(attempts, 3);
  assert.equal(failures, 1);
});

it('includes inline cloud points in cross-CRS refusal accounting (#10094, 3f)', async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
  const placement = (name: string): ModelSpatialPlacement => ({ spatialReference: spatialReferenceFromIfc({
    mapConversion: { id: 1, sourceCRS: 2, targetCRS: 3, eastings: 500000, northings: 5000000,
      orthogonalHeight: 0, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1 },
    projectedCRS: { id: 4, name, verticalDatum: 'EPSG:5729', mapUnitScale: 1 }, lengthUnitScale: 1,
  }) });
  const points = cloud([0, 0, 0]);
  points.chunk.positions = new Float32Array([0, 0, 0, 1, 0, 0, NaN, NaN, NaN, 1e30, 0, 0]);
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  const geometry = { meshes: [], pointClouds: [points], totalTriangles: 0, totalVertices: 0,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } };
  const original = points.chunk;
  assert.equal(await alignGeometryToReference(geometry, placement('EPSG:32632'), placement('EPSG:32633')), 'failed');
  assert.ok(warnings.some(([message]) => String(message).includes('1/3 vertex transforms failed')), JSON.stringify(warnings));
  assert.equal(points.chunk, original, 'failed staging leaves the cloud intact');
});
