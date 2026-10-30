/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Auto/Anchor/Exact decision and the anchor-error estimate behind it, on
 * the PROJ oracle's UTM 32N anchor at 11.9°E 50°N (`warp[1]`), 208 km east of
 * the central meridian. Expected values are worked by hand from the
 * estimate's definitions (R = 6 371 km):
 *   curvature r²/2R, plumb dH·r/R, geoid slope over the oracle's stated plane,
 *   and, for a grid source, |k(corner)/k(anchor) − 1|·r with the transverse
 *   Mercator dk/dE = k0·(E − E_cm)/R².
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import PROJ_ORACLE from './__fixtures__/proj-oracle.json' with { type: 'json' };
import { estimateAnchorError, planGlobePlacement, resolveGlobePlacement } from './globe-placement.js';
import type { ViewerBounds } from './geo-lattice.js';
import { geoidPlane, RIGID_OFFSET, rigidMapping } from '@/test/geo-warp-fixture.js';

const c = PROJ_ORACLE.warp[1];
const m = rigidMapping(c);
const options = (gridCoordinates: boolean) => ({
  projDef: c.proj4, gridCoordinates, geoid: geoidPlane(c.anchor), anchorMap: { easting: c.anchor.E, northing: c.anchor.N },
});
/** A square of half-width `half` metres round the anchor (viewer x = IFC x, viewer z = −IFC y), 100-130 m high. */
const square = (half: number): ViewerBounds => ({
  min: { x: RIGID_OFFSET.x - half, y: 100, z: -RIGID_OFFSET.y - half },
  max: { x: RIGID_OFFSET.x + half, y: 130, z: -RIGID_OFFSET.y + half },
});

describe('anchor-error estimate', () => {
  it('a 2 km grid-coordinate site: each term at its hand-worked value', () => {
    const e = estimateAnchorError(m, square(1000), options(true));
    // r = √2 km of grid over k = 1.00013: 1414.03 m of ground.
    assert.ok(Math.abs(e.curvature - 0.15692) < 2e-4, `curvature ${e.curvature}`); // 1414.03² / 12 742 000
    assert.ok(Math.abs(e.plumb - 0.006658) < 5e-5, `plumb ${e.plumb}`); // 30 · 1414.03 / 6 371 000
    // 0.8 m/° · 0.008993° + 0.5 m/° · 0.013975° at the NW and SE corners.
    assert.ok(Math.abs(e.geoidSlope - 0.01418) < 3e-4, `geoid slope ${e.geoidSlope}`);
    // 0.9996 · 207 819 / 6 381 000² · 1000 = 5.10e-6 at the east corners, times 1414 m.
    assert.ok(Math.abs(e.scaleVariation - 0.00722) < 4e-4, `scale variation ${e.scaleVariation}`);
    assert.ok(Math.abs(e.total - (e.curvature + e.plumb + e.geoidSlope + e.scaleVariation)) < 1e-12);
  });

  it('true-length geometry has no scale-variation term: it is drawn at its true length either way', () => {
    assert.equal(estimateAnchorError(m, square(1000), options(false)).scaleVariation, 0);
  });
});

describe('Auto, Anchor and Exact', () => {
  it('Auto keeps a 60 m building on its anchor (estimate under 1 cm)', () => {
    const plan = planGlobePlacement('auto', m, square(30), { ...options(true), mappingKey: 'k' });
    assert.ok(plan.estimate && plan.estimate.total < 0.01, `estimate ${plan.estimate?.total}`);
    assert.equal(plan.mode, 'anchor');
    assert.equal(plan.key, '', 'an Anchor GLB does not depend on the georeference');
  });

  it('Auto places a 2 km site point by point, keyed by everything the bake reads', () => {
    const plan = planGlobePlacement('auto', m, square(1000), { ...options(true), mappingKey: ['georef', 1] });
    assert.equal(plan.mode, 'exact');
    assert.equal(plan.key, JSON.stringify(['exact', ['georef', 1]]));
  });

  it('the explicit modes are taken as asked, and Auto without bounds stays on the anchor', () => {
    assert.equal(resolveGlobePlacement('exact', 0.001), 'exact');
    assert.equal(resolveGlobePlacement('anchor', 5), 'anchor');
    assert.equal(resolveGlobePlacement('auto', 0.0101), 'exact');
    assert.equal(resolveGlobePlacement('auto', 0.0099), 'anchor');
    const plan = planGlobePlacement('auto', m, undefined, { ...options(true), mappingKey: 'k' });
    assert.deepEqual(plan, { requested: 'auto', mode: 'anchor', estimate: null, key: '' });
  });
});
