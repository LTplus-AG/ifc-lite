/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A given footprint with a courtyard drawn as its own ring (review finding
 * "merged-distinct-entries"): a point inside any ring is inside, so the
 * courtyard is filled. A door on a thin wing's courtyard façade was then
 * sampled only on the street side and came out "no runoff mapped" with the
 * deep class in the courtyard.
 */

import { describe, expect, it } from 'vitest';
import { checkFloodExposure } from '../src/check/check.js';
import { prepareFootprint } from '../src/region.js';

const nestedRings = (rings: MapPoint[][]) => prepareFootprint({ rings, source: 'given' }).courtyards;
import type { FootprintSource } from '../src/model/facts.js';
import { CELL_NO_RUNOFF, type MapPoint } from '../src/types.js';
import { boxFacts, candidate, CODE, CONFIRMED, E0, flatTerrain, N0, syntheticRaster, NO_OTHER_BUILDINGS } from './helpers.js';

const sq = (x0: number, y0: number, x1: number, y1: number): MapPoint[] => [
  { x: E0 + x0, y: N0 + y0 }, { x: E0 + x1, y: N0 + y0 }, { x: E0 + x1, y: N0 + y1 }, { x: E0 + x0, y: N0 + y1 },
];
const deep = CODE['depth-gt-0.25'];

function run(wing: number, source: FootprintSource, paint: (p: MapPoint) => number, withCourtyardRing = true) {
  const rings = withCourtyardRing ? [sq(0, 0, 30, 30), sq(wing, wing, 30 - wing, 30 - wing)] : [sq(0, 0, 30, 30)];
  const door = candidate({ name: 'courtyard door', position: { x: E0 + 15, y: N0 + wing }, level: 500 });
  const street = candidate({ expressId: 2, name: 'street door', position: { x: E0 + 15, y: N0 }, level: 500 });
  const facts = boxFacts([door, street], { footprint: { rings, source, fromElements: [] } });
  return checkFloodExposure(facts, syntheticRaster(E0 - 10, N0 - 10, 100, 100, 0.5, paint), flatTerrain(499.95), { renderingConfirmation: CONFIRMED, otherBuildings: NO_OTHER_BUILDINGS });
}

describe('a given footprint with a courtyard ring', () => {
  for (const wing of [2, 10]) {
    const inCourt = (p: MapPoint) => p.x > E0 + wing && p.x < E0 + 30 - wing && p.y > N0 + wing && p.y < N0 + 30 - wing;
    const inOuter = (p: MapPoint) => p.x >= E0 && p.x <= E0 + 30 && p.y >= N0 && p.y <= N0 + 30;
    it(`${wing} m wings: the courtyard door is never reassuring, and stays exposed by a deep class on its sampled side`, () => {
      // A courtyard is open ground (since the automated review of 0b30b84): a deep class in it is sampled, so the door is
      // exposed; with the courtyard transparent the courtyard guard still withholds.
      expect(run(wing, 'given', (p: MapPoint) => (inCourt(p) ? deep : CELL_NO_RUNOFF)).results[0].outcome).toBe('exposed');
      const clear = run(wing, 'given', () => CELL_NO_RUNOFF).results[0];
      expect(clear.outcome).toBe('unclassified');
      expect(['courtyard-ring', 'no-ground-sample']).toContain(clear.unclassifiedReason);
      const outside = run(wing, 'given', (p) => (inOuter(p) ? CELL_NO_RUNOFF : deep)).results[0];
      // The thin wing's 3 m ring reaches the street; 10 m wings leave no sample at all.
      expect(outside.outcome).toBe(wing === 2 ? 'exposed' : 'unclassified');
    });
  }

  it('the thin wing, deep class in the courtyard only: the courtyard is sampled, so the door is exposed; transparent, it is withheld with the reason stated', () => {
    const r = run(2, 'given', (p) => (p.x > E0 + 2 && p.x < E0 + 28 && p.y > N0 + 2 && p.y < N0 + 28 ? deep : CELL_NO_RUNOFF));
    expect(r.results[0].outcome).toBe('exposed');
    const clear = run(2, 'given', () => CELL_NO_RUNOFF).results[0];
    expect(clear).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'courtyard-ring' });
    expect(clear.favourableWithheldBecause.join()).toMatch(/ring lying inside another ring \(a courtyard\)/);
    // The street door's 2-3 m rings cross the 2 m wing into the courtyard, which is now sampled as open ground: exposed. Samples
    // across a wing can only add readings, never make an outcome more favourable; with the courtyard clear it is no runoff.
    expect(r.results[1].outcome).toBe('exposed');
    expect(run(2, 'given', () => CELL_NO_RUNOFF).results[1].outcome).toBe('no-runoff-mapped');
  });

  it('as before for a slab outline whose void was filled: the courtyard door is withheld (anchor moved, hull footprint)', () => {
    const door = run(2, 'slab-outline-voids-filled', () => CELL_NO_RUNOFF, false).results[0];
    expect(door).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'anchor-moved' });
    expect(door.favourableWithheldBecause.join()).toMatch(/fills courtyards/);
  });

  it('a given footprint\'s courtyards: a ring inside another, not side-by-side or overlapping ones', () => {
    expect([...nestedRings([sq(0, 0, 30, 30), sq(10, 10, 20, 20)])]).toEqual([1]);
    expect([...nestedRings([sq(0, 0, 10, 10), sq(20, 0, 30, 10)])]).toEqual([]);
    expect([...nestedRings([sq(0, 0, 10, 10), sq(5, 5, 15, 15)])]).toEqual([]);
  });
});
