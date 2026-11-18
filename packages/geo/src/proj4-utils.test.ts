/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The convergence and point scale helpers against PROJ
 * (`__fixtures__/proj-oracle.json`, written by
 * `scripts/geo/generate-proj-oracle.py`).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import PROJ_ORACLE from './__fixtures__/proj-oracle.json' with { type: 'json' };
import { computeGridPointFactors } from './proj4-utils.js';

describe('grid point factors match PROJ', () => {
  for (const c of PROJ_ORACLE.cases) {
    for (const p of c.points) {
      const label = `${c.name} at ${p.lon.toFixed(2)}°E ${p.lat.toFixed(2)}°N`;
      it(`${label}: convergence and point scale on the WGS84 ellipsoid`, () => {
        const f = computeGridPointFactors(c.proj4, p.E, p.N);
        assert.ok(f);
        // Measured residuals are <= 5e-11 on both; 1e-9 leaves room for
        // proj4js/PROJ iteration tolerances while still failing the spherical
        // 111320 m/degree formula (1e-4 rad off at a 2.2° UTM convergence).
        assert.ok(Math.abs(f.gamma - p.gammaTrueNorth) < 1e-9, `gamma ${f.gamma} vs PROJ ${p.gammaTrueNorth}`);
        assert.ok(Math.abs(f.pointScale - p.kWgs84) < 1e-9, `k ${f.pointScale} vs PROJ ${p.kWgs84}`);
        if (c.sameEllipsoid) {
          // No datum shift: the WGS84 values ARE PROJ's get_factors (whose
          // convergence is positive clockwise, the opposite sign).
          const g = p.getFactors;
          const pgf = (-g.meridianConvergence * Math.PI) / 180;
          assert.ok(Math.abs(f.gamma - pgf) < 1e-9, `gamma ${f.gamma} vs get_factors ${pgf}`);
          const k = Math.sqrt(g.meridionalScale * g.parallelScale);
          assert.ok(Math.abs(f.pointScale - k) < 1e-9, `k ${f.pointScale} vs get_factors ${k}`);
        }
      });
    }
  }
});
