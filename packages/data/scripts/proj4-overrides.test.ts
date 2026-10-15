/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { PROJ4_OVERRIDES } from '../../../scripts/epsg-proj4-overrides.js';
import { lookupEpsgByCode } from '../src/epsg-index.js';

// The generator re-applies these after every fetch; this keeps the committed
// bundle and the override table from drifting apart (#7658).
describe('bundled EPSG index carries every proj4 override', () => {
  for (const [code, proj4] of PROJ4_OVERRIDES) {
    it(`EPSG:${code}`, async () => {
      expect((await lookupEpsgByCode(code))?.proj4).toBe(proj4);
    });
  }
});
