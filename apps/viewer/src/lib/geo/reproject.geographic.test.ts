/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { computeFootprintGeoJSON, reprojectFromLatLon, reprojectPointToLatLon, reprojectToLatLon } from './reproject.js';

// Independent pyproj 3.8 / PROJ 9.8 always_xy=True controls using the browser's
// resolved definitions. NAD27 uses its existing documented Helmert fallback,
// not the more precise unavailable NADCON grid. Monte Mario retains +pm=rome.
const controls = [
  { code: '4267', source: [-100, 40], wgs84: [-100.0004176222188, 40.00000948276804], inverse: [-100.00000000230257, 40.00000000005251] },
  { code: '4806', source: [0, 42], wgs84: [12.452333333333335, 42], inverse: [0, 42] },
];
const geometry: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: 100, y: 0, z: -300 }, max: { x: 200, y: 20, z: -200 } },
  shiftedBounds: { min: { x: 100, y: 0, z: -300 }, max: { x: 200, y: 20, z: -200 } },
  hasLargeCoordinates: false,
};
function close(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} differs from PROJ control ${expected}`);
}
for (const control of controls) {
  it(`EPSG:${control.code} geographic forward and inverse apply its datum/prime meridian (#7060)`, async () => {
    // Length units and metre geometry must not scale or offset source angles.
    const crs: ProjectedCRS = { id: 1, name: `EPSG:${control.code}`, mapUnitScale: 0.001 };
    const conversion: MapConversion = {
      id: 2, sourceCRS: 3, targetCRS: 1,
      eastings: control.source[0], northings: control.source[1], orthogonalHeight: 0,
    };
    const point = await reprojectPointToLatLon(conversion.eastings, conversion.northings, crs, 0.001);
    assert.ok(point);
    close(point.lon, control.wgs84[0]);
    close(point.lat, control.wgs84[1]);
    const center = await reprojectToLatLon(conversion, crs, geometry, 0.001);
    assert.deepEqual(center, point);
    const inverse = await reprojectFromLatLon({ lon: control.wgs84[0], lat: control.wgs84[1] }, crs, 0.001);
    assert.ok(inverse);
    close(inverse.easting, control.inverse[0]);
    close(inverse.northing, control.inverse[1]);
    assert.equal(await computeFootprintGeoJSON(conversion, crs, geometry, 0.001), null);
  });
}

it('WGS84 geographic coordinates remain angles, and invalid angles are refused in both directions (#7060)', async () => {
  const crs: ProjectedCRS = { id: 1, name: 'EPSG:4326', mapUnitScale: 0.001 };
  const point = { lon: 5, lat: 52 };
  const forward = await reprojectPointToLatLon(point.lon, point.lat, crs, 0.001);
  assert.ok(forward);
  close(forward.lon, point.lon);
  close(forward.lat, point.lat);
  const inverse = await reprojectFromLatLon(point, crs, 0.001);
  assert.ok(inverse);
  close(inverse.easting, point.lon);
  close(inverse.northing, point.lat);
  for (const invalid of [{ lon: NaN, lat: 52 }, { lon: 181, lat: 52 }, { lon: 5, lat: 91 }, { lon: Infinity, lat: 0 }]) {
    assert.equal(await reprojectPointToLatLon(invalid.lon, invalid.lat, crs), null);
    assert.equal(await reprojectFromLatLon(invalid, crs), null);
  }
});
