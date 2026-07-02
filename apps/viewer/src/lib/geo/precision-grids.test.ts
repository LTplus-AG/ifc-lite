/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { PRECISION_GRIDS, isHorizontalOffsetGrid } from './precision-grids.js';

describe('precision-grids datum-shift table (#1357)', () => {
  it('treats only >=2-band grids as horizontal datum shifts', () => {
    // 1-band = vertical/height model (e.g. a quasigeoid) — proj4's +nadgrids
    // reader would dereference a missing 2nd band and throw.
    assert.equal(isHorizontalOffsetGrid(1), false);
    assert.equal(isHorizontalOffsetGrid(0), false);
    assert.equal(isHorizontalOffsetGrid(2), true); // lat + lon offsets
    assert.equal(isHorizontalOffsetGrid(4), true); // + accuracy bands
  });

  it('never registers the vertical cz_cuzk_CR-2005 grid as a horizontal +nadgrids', () => {
    // cz_cuzk_CR-2005.tif is a VERTICAL_OFFSET (ETRS89 -> Baltic height) grid;
    // using it as a horizontal datum shift crashed proj4 and forced the
    // +towgs84 fallback (the "grid failed" badge). It must not reappear.
    for (const [code, spec] of Object.entries(PRECISION_GRIDS)) {
      assert.ok(
        !/cz_cuzk_CR-2005/i.test(spec.filename),
        `EPSG:${code} references the vertical CR-2005 grid (${spec.filename})`,
      );
      assert.ok(
        !spec.proj4.includes('cz_cuzk_CR-2005'),
        `EPSG:${code} proj4 string references the vertical CR-2005 grid`,
      );
    }
  });

  it('drops the broken S-JTSK (5514 / 2065) precision-grid entries', () => {
    // No single horizontal grid takes S-JTSK -> ETRS89 in PROJ-data, so these
    // CRSs intentionally fall back to the bundled +towgs84 (~1 m) with no grid.
    assert.equal(PRECISION_GRIDS['5514'], undefined);
    assert.equal(PRECISION_GRIDS['2065'], undefined);
  });

  it('keeps genuine horizontal grids (e.g. NL RD, Slovakia JTSK03)', () => {
    assert.ok(PRECISION_GRIDS['28992'], 'NL RD should keep its precision grid');
    assert.ok(PRECISION_GRIDS['5513'], 'Slovak JTSK03 (2-band horizontal) should remain');
  });
});
