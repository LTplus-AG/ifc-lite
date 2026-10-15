/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { reprojectPointToLatLon, type LatLon } from './reproject.js';

/** Metres per degree of latitude; longitude is scaled by cos(lat). */
const M_PER_DEG = 111_320;

function offsetMetres(actual: LatLon, expected: LatLon): number {
  const dy = (actual.lat - expected.lat) * M_PER_DEG;
  const dx = (actual.lon - expected.lon) * M_PER_DEG * Math.cos((expected.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/**
 * DB_REF (Deutsche Bahn, Bessel 1841) CRSs through the viewer's own resolve +
 * reproject path (#7658). Expected values are PROJ 9.3 output (EPSG:5826 "DB_REF
 * to ETRS89 (1)"), which is what QGIS shows. The projected and compound codes
 * are also covered by packages/data's control-point fixtures; the geographic
 * ones only here, since that verifier treats longlat CRSs as identity.
 */
const CASES = [
  { code: '9933', x: 3_395_000, y: 5_589_400, expected: { lat: 50.431063, lon: 7.5211466 } },
  { code: '5681', x: 7.52, y: 50.43, expected: { lat: 50.428802015, lon: 7.519172328 } },
  { code: '5830', x: 7.52, y: 50.43, expected: { lat: 50.428802015, lon: 7.519172328 } },
];

for (const { code, x, y, expected } of CASES) {
  it(`EPSG:${code} applies the DB_REF to ETRS89 datum shift (#7658)`, async () => {
    const result = await reprojectPointToLatLon(x, y, { id: 1, name: `EPSG:${code}`, mapUnitScale: 1 });
    assert.ok(result, `EPSG:${code} did not resolve`);
    const offset = offsetMetres(result, expected);
    assert.ok(offset < 0.5, `EPSG:${code} lands ${offset.toFixed(2)} m off (${result.lat}, ${result.lon})`);
  });
}
