/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { egm96Undulation } from './egm96-undulation.js';

// Reference EGM96 undulations from the egm96-universal 15' model used to
// generate the bundled grid. Integer-degree points are grid nodes (match to
// cm); city points exercise bilinear interpolation (within the 1° interp error).
describe('egm96Undulation (#1355)', () => {
  it('matches grid nodes to centimetre precision', () => {
    assert.ok(Math.abs(egm96Undulation(50, 14) - 45.780) < 0.02, `50,14 => ${egm96Undulation(50, 14)}`);
    assert.ok(Math.abs(egm96Undulation(47, 7) - 49.310) < 0.02, `47,7 => ${egm96Undulation(47, 7)}`);
    assert.ok(Math.abs(egm96Undulation(0, 0) - 17.160) < 0.02, `0,0 => ${egm96Undulation(0, 0)}`);
  });

  it('interpolates city points within ~1.2 m of the full model', () => {
    // 1° bilinear interp error stays well under a metre on smooth geoid, and
    // reaches ~1 m only in steep-gradient (alpine) areas — fine for correcting
    // a ~45 m gross placement error.
    const cases: Array<[string, number, number, number]> = [
      ['Prague', 50.08, 14.42, 45.122],
      ['Bern', 46.95, 7.44, 48.789],
      ['Zurich', 47.37, 8.54, 47.339],
      ['NYC', 40.71, -74.0, -32.755],
    ];
    for (const [name, lat, lon, expected] of cases) {
      const n = egm96Undulation(lat, lon);
      assert.ok(Math.abs(n - expected) < 1.2, `${name}: got ${n.toFixed(3)}, expected ~${expected}`);
    }
  });

  it('captures the sign + magnitude that buries Central-European models (~+45 m)', () => {
    // The bug: a ~45 m orthometric->ellipsoidal gap sinks the model below terrain.
    assert.ok(egm96Undulation(50.08, 14.42) > 40, 'Czechia undulation should be ~+45 m');
    assert.ok(egm96Undulation(46.95, 7.44) > 45, 'Switzerland undulation should be ~+49 m');
  });

  it('is finite and bounded everywhere, and longitude wraps', () => {
    for (let lat = -90; lat <= 90; lat += 15) {
      for (let lon = -180; lon <= 180; lon += 15) {
        const n = egm96Undulation(lat, lon);
        assert.ok(Number.isFinite(n) && n > -110 && n < 90, `${lat},${lon} => ${n}`);
      }
    }
    // +180 and -180 are the same meridian.
    assert.ok(Math.abs(egm96Undulation(10, 180) - egm96Undulation(10, -180)) < 0.02);
    // out-of-range longitude wraps in.
    assert.ok(Math.abs(egm96Undulation(50.08, 14.42 + 360) - egm96Undulation(50.08, 14.42)) < 0.02);
  });

  it('returns 0 for non-finite input', () => {
    assert.equal(egm96Undulation(NaN, 10), 0);
    assert.equal(egm96Undulation(10, Infinity), 0);
  });
});
