/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { reprojectPointToLatLon } from './reproject.js';

// Regression for the missing deprecated compounds in #7658. PROJ 9.8.1
// (pyproj 3.8.0): Transformer.from_crs(code, 4326, always_xy=True).transform(x, y).
// EPSG:5834 is the MapConversion origin in the public IFC4.x-IF
// Georeferencing_PROJCS,VERTCS(EPSG)-MC.ifc reference file.
const CASES = [
  { code: '5834', x: 4_468_005, y: 5_334_600, lon: 11.568577311077236, lat: 48.148613762260 },
  { code: '5833', x: 3_395_000, y: 5_589_400, lon: 7.521146637730453, lat: 50.431063039250624 },
];

for (const { code, x, y, lat, lon } of CASES) {
  it(`EPSG:${code} uses its bundled horizontal datum shift without network (#7658)`, async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('Compound CRS resolution must work offline');
    });
    const result = await reprojectPointToLatLon(x, y, { id: 1, name: `EPSG:${code}`, mapUnitScale: 1 });
    assert.equal(fetch.mock.callCount(), 0, 'Must not consult epsg.io for a bundled horizontal component');
    assert.ok(result, `EPSG:${code} did not resolve`);
    const dy = (result.lat - lat) * 111_320;
    const dx = (result.lon - lon) * 111_320 * Math.cos(lat * Math.PI / 180);
    const offset = Math.hypot(dx, dy);
    assert.ok(offset < 0.5, `EPSG:${code} lands ${offset.toFixed(3)} m off PROJ (${result.lon}, ${result.lat})`);
  });
}
