/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backgroundReference, orthophotoProjection } from './orthophotoBackground';
import { spatialReferenceFromIfc } from '@/lib/geo/ifc-spatial-reference';
import { georeferencedPlacementFrameKey } from '@/lib/model-placement/persistence';
import { planOrthophotoBackground } from '@/lib/terrain-imagery/background-plan';
import { localViewerToProjected } from '@ifc-lite/geometry';
import proj4 from 'proj4';
import { projectedDefinitionInMetres } from '@/lib/geo/proj4-utils';

const reference = spatialReferenceFromIfc({
  mapConversion: { id: 1, sourceCRS: 1, targetCRS: 2, eastings: 2600000, northings: 1200000,
    orthogonalHeight: 500, scale: 1, xAxisAbscissa: 0, xAxisOrdinate: 1 },
  projectedCRS: { id: 2, name: 'EPSG:2056', mapUnitScale: 1 }, lengthUnitScale: 1,
});

test('background uses the committed rotated frame and rejects unreferenced IFC (#8552)', () => {
  const restored = backgroundReference(georeferencedPlacementFrameKey({ spatialReference: reference }));
  // Independent landmark: a metre along local X maps north after 90° rotation.
  assert.deepEqual(localViewerToProjected(restored, [1, 0, 0]), [2600000, 1200001, 500]);
  assert.throws(() => backgroundReference('local-engineering:m:z-up'), /IfcMapConversion/);
  assert.throws(() => backgroundReference(JSON.stringify({ spatialReference: { horizontal: 'Swiss Grid' } })), /EPSG/);
});

test('background sampling converts native US-survey-foot raster coordinates to model metres (#8552)', () => {
  const native = '+proj=lcc +lat_1=33.90363402777778 +lat_2=33.62529002777778 +lat_0=33.76446202777777 +lon_0=-117.4745428888889 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=us-ft +no_defs';
  const converter = proj4(native, projectedDefinitionInMetres(native));
  const foot = 1200 / 3937;
  const ref = spatialReferenceFromIfc({ mapConversion: { id: 1, sourceCRS: 1, targetCRS: 2,
    eastings: 3000000 * foot, northings: 6000000 * foot, orthogonalHeight: 0, scale: 1 },
    projectedCRS: { id: 2, name: 'EPSG:2226', mapUnitScale: 1 }, lengthUnitScale: 1 });
  const plan = planOrthophotoBackground({ width: 100, height: 100,
    affine: { a: 1, b: 0, c: 3000000, d: 0, e: -1, f: 6000100 },
    crs: 'EPSG:2226', crsSource: 'GeoKeys', placement: 'GeoTIFF' }, ref, {
    forward: p => converter.forward([...p]) as [number, number], inverse: p => converter.inverse([...p]) as [number, number],
  }, 0);
  // 100 ft width plus a 1 ft margin on either side.
  assert.ok(Math.abs(plan.corners[1][0] - plan.corners[0][0] - 102 * foot) < 1e-6);
});

// RD New needs a grid only when changing datums; same-CRS imagery must work offline.
test('same-CRS aerial background requires no datum transformation (#8552)', async () => {
  const projection = await orthophotoProjection('EPSG:28992', 'EPSG:28992');
  const [e, n] = projection.forward([90770, 435320]);
  assert.ok(Math.abs(e - 90770) < 1e-6);
  assert.ok(Math.abs(n - 435320) < 1e-6);
});
