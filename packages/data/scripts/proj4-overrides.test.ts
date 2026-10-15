/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import { PROJ4_OVERRIDES } from '../../../scripts/epsg-proj4-overrides.js';
import { lookupEpsgByCode } from '../src/epsg-index.js';

// The generator writes these strings into the bundle after every fetch; the
// bundle carrying exactly the override table is the contract checked here
// (#7658). Placement accuracy is checked by the control-point fixtures.
describe('bundled EPSG index carries every proj4 override', () => {
  for (const [code, definition] of PROJ4_OVERRIDES) {
    it(`EPSG:${code}`, async () => {
      expect((await lookupEpsgByCode(code))?.proj4).toBe(definition);
    });
  }
});

// Geocentric DB_REF has no fixture (the round-trip verifier is 2D). PROJ 9.3:
// EPSG:5828 (4040000, 533000, 4895000) -> WGS84 7.514840053 / 50.410395459.
it('EPSG:5828 (geocentric DB_REF) applies the datum shift (#7658)', async () => {
  const definition = (await lookupEpsgByCode('5828'))?.proj4;
  expect(definition).toBeTruthy();
  const [lon, lat] = proj4(definition!, 'WGS84', [4_040_000, 533_000, 4_895_000]);
  expect(lon).toBeCloseTo(7.514840053, 6);
  expect(lat).toBeCloseTo(50.410395459, 6);
});
