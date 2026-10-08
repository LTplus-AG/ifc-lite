/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { computeCesiumModelOrigin, computeGridConvergence, createCesiumBridge } from './cesium-bridge.js';
import {
  computeFootprintGeoJSON, reprojectFromLatLon, reprojectPointToLatLon,
  reprojectToLatLon,
} from './reproject.js';

const close = (actual: number, expected: number, tolerance = 1e-7) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const usFoot = 1200 / 3937;

// Independent pyproj 3.8.0 / PROJ 9.8.1, always_xy=True, EPSG -> EPSG:4326.
// These are native US-survey-foot coordinates, not metre projection offsets.
const controls = [
  { code: '2236', e: 200000, n: 0, lon: -82.3699406494346, lat: 24.32715010183609 },
  { code: '2277', e: 3000000, n: 10000000, lon: -98.10931642394452, lat: 30.080371423181575 },
  { code: '2227', e: 6000000, n: 2000000, lon: -122.43557284182455, lat: 37.47161770577077 },
];
const crsFor = (code: string): ProjectedCRS => ({
  id: 1, name: `EPSG:${code}`, mapUnit: 'US survey foot', mapUnitScale: usFoot,
});

function conversion(eastings: number, northings: number): MapConversion {
  return { id: 2, sourceCRS: 3, targetCRS: 1, eastings, northings,
    orthogonalHeight: 0, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1 };
}

function bounds(x: number, north: number): CoordinateInfo {
  const point = { x, y: 0, z: -north };
  return { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
    originalBounds: { min: point, max: point }, shiftedBounds: { min: point, max: point } };
}

describe('native projection units at metre geometry boundaries (#7056)', () => {
  for (const control of controls) {
    it(`projects and unprojects EPSG:${control.code} against independent PROJ controls`, async () => {
      const crs = crsFor(control.code);
      const point = await reprojectPointToLatLon(control.e, control.n, crs);
      assert.ok(point);
      close(point.lon, control.lon);
      close(point.lat, control.lat);
      const mapConversion = conversion(control.e, control.n);
      const origin = await computeCesiumModelOrigin(mapConversion, crs, undefined, usFoot, undefined, true);
      assert.ok(origin);
      close(origin.longitude, control.lon);
      close(origin.latitude, control.lat);
      const bridge = await createCesiumBridge(mapConversion, crs, undefined, usFoot, undefined, true);
      assert.ok(bridge);
      const picked = bridge.viewerToGeodetic(0, 0, 0);
      assert.ok(picked);
      close(picked.longitude, control.lon);
      close(picked.latitude, control.lat);
      const inverse = await reprojectFromLatLon({ lon: control.lon, lat: control.lat }, crs);
      assert.ok(inverse);
      close(inverse.easting, control.e, 0.001);
      close(inverse.northing, control.n, 0.001);

      // With metre-valued IFC geometry and a metre MapUnit, the CRS still
      // specifies feet. The geometry boundary must convert exactly once.
      const metreCrs = { ...crs, mapUnit: 'METRE', mapUnitScale: 1 };
      const info = bounds(control.e * usFoot, control.n * usFoot);
      const center = await reprojectToLatLon(conversion(0, 0), metreCrs, info);
      assert.ok(center);
      close(center.lon, control.lon);
      close(center.lat, control.lat);
      const footprint = await computeFootprintGeoJSON(conversion(0, 0), metreCrs, info);
      assert.ok(footprint);
      for (const [lon, lat] of footprint) {
        close(lon, control.lon);
        close(lat, control.lat);
      }
    });
  }

  it('normalizes explicit +to_meter while retaining metre false offsets', () => {
    const definition = '+proj=tmerc +lat_0=0 +lon_0=9 +k=1 +x_0=500000 '
      + '+y_0=0 +datum=WGS84 +units=ft +to_meter=0.3048';
    close(computeGridConvergence(definition, 500000, 0, 9, 0), 0);
  });

});
