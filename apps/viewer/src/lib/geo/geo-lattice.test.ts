/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GeoWarp's lattice interpolation (#8189) against PROJ: the oracle's
 * 20 km lines (`__fixtures__/proj-oracle.json`, `warp`) through a 100 m
 * lattice, compared with PROJ's ECEF, not with the exact mapping alone.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import PROJ_ORACLE from './__fixtures__/proj-oracle.json' with { type: 'json' };
import { enuFrameAt } from './geo-ecef.js';
import { createGeoMapping, type GeoMapping } from './geo-warp.js';
import { createLatticeWarp, type ViewerBounds } from './geo-lattice.js';
import { dist, ecefOf, geoidPlane, gridViewer, rigidLine, type WarpCase } from '@/test/geo-warp-fixture.js';

function rigidMapping(c: WarpCase): GeoMapping {
  const m = createGeoMapping({
    ...rigidLine(c), projDef: c.proj4, geoid: geoidPlane(c.anchor),
    origin: {
      longitude: c.anchor.lon, latitude: c.anchor.lat, height: c.anchor.h, ifcOriginHeight: c.anchor.H,
      easting: c.anchor.E, northing: c.anchor.N, scaleX: 1, scaleY: 1, scaleZ: 1,
      combinedScaleFactor: 1, gridSource: 'rigidOperation',
    },
  });
  assert.ok(m);
  return m;
}

/** The line's box, its minimum corner pulled back 37 m so oracle points fall between lattice nodes. */
function offGridBounds(c: WarpCase): ViewerBounds {
  const { shiftedBounds: b } = rigidLine(c).coordinateInfo;
  return { min: { x: b.min.x - 37, y: b.min.y, z: b.min.z - 37 }, max: b.max };
}

describe('GeoWarp lattice vs PROJ', () => {
  for (const c of PROJ_ORACLE.warp) {
    it(`${c.case} at ${c.anchor.lon.toFixed(2)}°E: a 100 m lattice interpolates the 20 km line within 1 mm`, () => {
      const m = rigidMapping(c);
      const lattice = createLatticeWarp(m, offGridBounds(c));
      assert.ok(lattice);
      assert.equal(lattice.cellSize, 100);
      const frame = enuFrameAt(m.anchor.latitude, m.anchor.longitude, m.anchor.height);
      let worst = 0;
      for (const p of c.points) {
        const out = [0, 0, 0];
        lattice.warp(...gridViewer(p), out);
        worst = Math.max(worst, dist(ecefOf(frame, out), p.ecef));
      }
      assert.ok(worst < 1e-3, `worst ${(worst * 1000).toFixed(4)} mm`);
    });
  }

  it('is exact vertically: a point between and beyond the two levels lands on the exact mapping', () => {
    const c = PROJ_ORACLE.warp[1];
    const m = rigidMapping(c);
    const lattice = createLatticeWarp(m, offGridBounds(c));
    assert.ok(lattice);
    const [x, , z] = gridViewer(c.points[10]);
    for (const y of [100, 117.3, 150, 260]) {
      const a = [0, 0, 0], b = [0, 0, 0];
      lattice.warp(x, y, z, a);
      assert.ok(m.toEnu(x, y, z, b));
      // Horizontal bilinear residual only (sub-millimetre), independent of y.
      assert.ok(dist(a, b) < 5e-4, `y ${y}: ${(dist(a, b) * 1000).toFixed(4)} mm`);
    }
  });

  it('a coarse lattice shows the c²/4R residual it is sized against (2 km cells: decimetres)', () => {
    const c = PROJ_ORACLE.warp[0];
    const m = rigidMapping(c);
    const lattice = createLatticeWarp(m, offGridBounds(c), 2000);
    assert.ok(lattice);
    const frame = enuFrameAt(m.anchor.latitude, m.anchor.longitude, m.anchor.height);
    let worst = 0;
    for (const p of c.points) {
      const out = [0, 0, 0];
      lattice.warp(...gridViewer(p), out);
      worst = Math.max(worst, dist(ecefOf(frame, out), p.ecef));
    }
    // c²/(8R) per axis, so (2000 m)² / (4 · 6.38e6 m) = 15.7 cm at a cell centre.
    assert.ok(worst > 0.1 && worst < 0.16, `worst ${(worst * 1000).toFixed(1)} mm`);
  });

  it('refuses a non-finite box or cell size, and a box with an unplaceable node', () => {
    const c = PROJ_ORACLE.warp[0];
    const m = rigidMapping(c);
    const b = offGridBounds(c);
    assert.equal(createLatticeWarp(m, { ...b, max: { ...b.max, x: Number.NaN } }), null);
    assert.equal(createLatticeWarp(m, b, 0), null);
    const refusing: GeoMapping = { ...m, toEnu: (x, y, z, out) => x < b.max.x - 1 && m.toEnu(x, y, z, out) };
    assert.equal(createLatticeWarp(refusing, b), null);
  });
});
