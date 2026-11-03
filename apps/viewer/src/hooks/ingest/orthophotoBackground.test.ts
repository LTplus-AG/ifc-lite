/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backgroundReference, orthophotoProjection, orthophotoElevation } from './orthophotoBackground';
import { spatialReferenceFromIfc } from '@/lib/geo/ifc-spatial-reference';
import { georeferencedPlacementFrameKey } from '@/lib/model-placement/persistence';
import { planOrthophotoBackground } from '@/lib/terrain-imagery/background-plan';
import { localViewerToProjected } from '@ifc-lite/geometry';
import proj4 from 'proj4';
import type { GeometryResult } from '@ifc-lite/geometry';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
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


test('same-CRS US-survey-foot imagery converts native units through the production projection (#8552)', async () => {
  const projection = await orthophotoProjection('EPSG:2226', 'EPSG:2226');
  const foot = 1200 / 3937;
  const [e, n] = projection.forward([1000, 2000]);
  assert.ok(Math.abs(e - 1000 * foot) < 1e-9);
  assert.ok(Math.abs(n - 2000 * foot) < 1e-9);
  const [x, y] = projection.inverse([e, n]);
  assert.ok(Math.abs(x - 1000) < 1e-9);
  assert.ok(Math.abs(y - 2000) < 1e-9);
});


function elevationGeometry(minimum: number, shift = 0, rtc = 0): GeometryResult {
  const bounds = { min: { x: 0, y: minimum, z: 0 }, max: { x: 10, y: minimum + 10, z: 10 } };
  return { meshes: [], totalTriangles: 0, totalVertices: 0, coordinateInfo: {
    originShift: { x: 0, y: shift, z: 0 }, wasmRtcOffset: { x: 0, y: 0, z: rtc },
    shiftedBounds: bounds, originalBounds: bounds, hasLargeCoordinates: shift !== 0,
  } };
}

test('background stays below every federated IFC regardless of selected result or load order (#8552)', () => {
  const high = { ...fixtureModel('high'), geometryResult: elevationGeometry(100) };
  const low = { ...fixtureModel('low'), geometryResult: elevationGeometry(0) };
  for (const models of [[high], [low], [high, low], [low, high]]) {
    const expected = models.includes(low) ? -0.05 : 99.95;
    for (const selected of [high, low]) {
      assert.equal(orthophotoElevation({ geometryStreamingActive: false, ...fixtureModels(...models), geometryResult: selected.geometryResult }), expected);
    }
  }
});

test('background compares restored world heights, including origin shift and IFC Z-up RTC (#8552)', () => {
  const high = { ...fixtureModel('high'), geometryResult: elevationGeometry(-100, 150, 50) };
  const low = { ...fixtureModel('low'), geometryResult: elevationGeometry(20, -30, 10) };
  assert.equal(orthophotoElevation({ geometryStreamingActive: false, ...fixtureModels(high, low), geometryResult: high.geometryResult }), -0.05);
  assert.equal(orthophotoElevation({ geometryStreamingActive: false, models: new Map(), geometryResult: high.geometryResult }), 99.95);
});


test('background refuses absent, incomplete and invalid geometry instead of guessing elevation (#8552)', () => {
  const complete = { ...fixtureModel('complete'), loadState: 'complete' as const, geometryResult: elevationGeometry(-20) };
  const settled = { ...fixtureModels(complete), geometryResult: complete.geometryResult, geometryStreamingActive: false };
  assert.throws(() => orthophotoElevation({ ...settled, geometryStreamingActive: true }), /finish loading/);
  for (const loadState of ['pending', 'streaming-geometry', 'hydrating-metadata', 'error'] as const) {
    const incomplete = { ...fixtureModel('incomplete'), loadState, geometryResult: elevationGeometry(-100) };
    assert.throws(() => orthophotoElevation({ ...settled, ...fixtureModels(complete, incomplete) }), /finish loading/);
  }
  const absent = { ...fixtureModel('absent'), loadState: 'complete' as const, geometryResult: null };
  assert.throws(() => orthophotoElevation({ ...settled, ...fixtureModels(complete, absent) }), /bounds are unavailable/);
  assert.throws(() => orthophotoElevation({ ...settled, models: new Map(), geometryResult: null }), /bounds are unavailable/);
  const invalid = { ...complete, geometryResult: elevationGeometry(NaN) };
  assert.throws(() => orthophotoElevation({ ...settled, ...fixtureModels(invalid) }), /bounds are invalid/);
  assert.equal(orthophotoElevation(settled), -20.05, 'completed below-zero geometry has a measured elevation');
});
