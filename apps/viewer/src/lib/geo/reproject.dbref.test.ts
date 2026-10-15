/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { reprojectPointToLatLon } from './reproject.js';
import { distanceMetres } from './site-ref-mismatch.js';

/**
 * DB_REF (Deutsche Bahn, Bessel 1841) projected and DB_REF2003/2016 compound CRSs
 * place an IfcMapConversion about 146-180 m off without the Position Vector
 * Helmert to ETRS89 (#7658). Expected values are PROJ 9.3 output for the same
 * input (EPSG:5826 "DB_REF to ETRS89 (1)"), which is what QGIS shows.
 */
const CASES = [
  { codes: ['5682', '9928', '9932'], e: 2_550_000, lat: 50.4383195, lon: 6.7032099 },
  { codes: ['5683', '9929', '9933'], e: 3_395_000, lat: 50.431063, lon: 7.5211466 },
  { codes: ['5684', '9930', '9934'], e: 4_450_000, lat: 50.4383367, lon: 11.2947006 },
  { codes: ['5685', '9931', '9935'], e: 5_450_000, lat: 50.4383623, lon: 14.2942622 },
];

for (const { codes, e, lat, lon } of CASES) {
  for (const code of codes) {
    it(`EPSG:${code} applies the DB_REF to ETRS89 datum shift (#7658)`, async () => {
      const result = await reprojectPointToLatLon(e, 5_589_400, { id: 1, name: `EPSG:${code}`, mapUnitScale: 1 });
      assert.ok(result, `EPSG:${code} did not resolve`);
      const offset = distanceMetres(result, { lat, lon });
      assert.ok(offset < 0.5, `EPSG:${code} lands ${offset.toFixed(2)} m off (${result.lat}, ${result.lon})`);
    });
  }
}
