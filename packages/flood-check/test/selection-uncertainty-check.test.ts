/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review round on head 4fa60bd3: an element must not be excluded, or cleared,
 * on data that is known to be incomplete or stale.
 */

import { describe, expect, it } from 'vitest';
import { checkFloodExposure } from '../src/check/check.js';
import { CELL_NO_RUNOFF, type MapPoint } from '../src/types.js';
import { boxFacts, candidate, CODE, CONFIRMED, E0, flatTerrain, N0, syntheticRaster } from './helpers.js';

const deep = CODE['depth-gt-0.25'];
const sq = (x0: number, y0: number, x1: number, y1: number): MapPoint[] => [
  { x: E0 + x0, y: N0 + y0 }, { x: E0 + x1, y: N0 + y0 }, { x: E0 + x1, y: N0 + y1 }, { x: E0 + x0, y: N0 + y1 },
];
const inBox = (p: MapPoint, x0: number, y0: number, x1: number, y1: number) => p.x > E0 + x0 && p.x < E0 + x1 && p.y > N0 + y0 && p.y < N0 + y1;

describe('the courtyard guard', () => {
  it('follows rings appended to the same footprint array between checks (no stale cache)', () => {
    const rings = [sq(0, 0, 30, 30)];
    const door = candidate({ name: 'Hoftür', position: { x: E0 + 15, y: N0 + 2 }, level: 500 });
    const facts = boxFacts([door], { footprint: { rings, source: 'given', fromElements: [] } });
    const raster = syntheticRaster(E0 - 10, N0 - 10, 100, 100, 0.5, (p) => (inBox(p, 2, 2, 28, 28) ? deep : CELL_NO_RUNOFF));
    checkFloodExposure(facts, raster, flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
    rings.push(sq(2, 2, 28, 28)); // the courtyard, added in place
    const r = checkFloodExposure(facts, raster, flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
    // The courtyard is recognised, so its ground (the deep class) is sampled: exposed. Unrecognised, the door would be anchored
    // on the outer façade 1+ m away (anchor-moved). Before the automated review of 0b30b84 a courtyard was filled: courtyard-ring.
    expect(r.results[0].outcome).toBe('exposed');
  });

  it('recognises a courtyard ring that two overlapping rings cover only together', () => {
    // A = 0..6 x 0..10 and B = 4..10 x 0..10 overlap; the courtyard C = 2..8 x 1..9 lies in neither alone.
    const rings = [sq(0, 0, 6, 10), sq(4, 0, 10, 10), sq(2, 1, 8, 9)];
    const door = candidate({ name: 'Hoftür', position: { x: E0 + 5, y: N0 + 1 }, level: 500 });
    const facts = boxFacts([door], { footprint: { rings, source: 'given', fromElements: [] } });
    const raster = syntheticRaster(E0 - 10, N0 - 10, 60, 60, 0.5, (p) => (inBox(p, 2, 1, 8, 9) ? deep : CELL_NO_RUNOFF));
    const r = checkFloodExposure(facts, raster, flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
    // The courtyard is recognised, so its ground (the deep class) is sampled: exposed. Unrecognised, the door would be anchored
    // on the outer façade 1+ m away (anchor-moved). Before the automated review of 0b30b84 a courtyard was filled: courtyard-ring.
    expect(r.results[0].outcome).toBe('exposed');
  });
});

