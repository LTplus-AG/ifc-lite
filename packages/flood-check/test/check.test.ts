/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { checkFloodExposure } from '../src/check/check.js';
import { planSamples, resolveSampling } from '../src/check/sampling.js';
import { FloodCheckRefusal } from '../src/errors.js';
import { CELL_NO_RUNOFF, CELL_UNCLASSIFIED, type MapPoint, type TerrainSampler } from '../src/types.js';
import { boxFacts, candidate, CODE, E0, flatTerrain, N0, syntheticRaster } from './helpers.js';

/** Raster over the box building and 10 m around it, 0.5 m cells. */
const raster = (paint: (p: MapPoint) => number) => syntheticRaster(E0 - 10, N0 - 10, 80, 60, 0.5, paint);
const south = (code: number) => (p: MapPoint) => (p.y < N0 ? code : CELL_NO_RUNOFF);
const door = (level: number, over = {}) => candidate({ position: { x: E0 + 10, y: N0 }, level, ...over });

function run(level: number, paint: (p: MapPoint) => number, terrain: TerrainSampler = flatTerrain(500), over = {}) {
  return checkFloodExposure(boxFacts([door(level, over)]), raster(paint), terrain).results[0];
}

describe('ground sampling', () => {
  it('reads only ring points clearly outside the footprint, around the façade', () => {
    const plan = planSamples(door(500), boxFacts([]).footprint, resolveSampling());
    expect(plan.points.length).toBe(12);
    expect(plan.points.every(({ point }) => point.y <= N0 - 1)).toBe(true);
    expect(plan.rejected).toBe(20);
  });

  it('anchors an interior element on the nearest point of the outline', () => {
    const boiler = candidate({ category: 'equipment', ifcClass: 'IfcBoiler', position: { x: E0 + 10, y: N0 + 3 }, level: 497 });
    const result = checkFloodExposure(boxFacts([boiler]), raster(south(CODE['depth-0-0.1'])), flatTerrain(500)).results[0];
    expect(result.anchorBasis).toBe('nearest-outline-point');
    expect(result.anchor.x).toBeCloseTo(E0 + 10, 9);
    expect(result.anchor.y).toBeCloseTo(N0, 9);
    expect(result.outcome).toBe('exposed');
  });

  it('ignores a class drawn inside the footprint (the model raised buildings 5 m)', () => {
    const inside = (p: MapPoint) => (p.x > E0 && p.x < E0 + 20 && p.y > N0 && p.y < N0 + 10 ? CODE['depth-gt-0.25'] : CELL_NO_RUNOFF);
    expect(run(499, inside).outcome).toBe('no-runoff-mapped');
  });
});

describe('outcomes', () => {
  const mid = CODE['depth-0.1-0.25'];

  it('clear / within / exposed on both sides of the thresholds, with the numbers', () => {
    // T = 500, class (0.1, 0.25], margin 0.5 → exposed at z <= 500.1, clear at z > 500.75.
    const clear = run(500.76, south(mid));
    expect(clear.outcome).toBe('clear');
    expect(clear.terrainHeight).toBe(500);
    expect(clear.hazardClass?.id).toBe('depth-0.1-0.25');
    expect(clear.comparison?.levelAboveSurfaceUpperBound).toBeCloseTo(0.51, 9);
    expect(run(500.74, south(mid)).outcome).toBe('within-class-range');
    expect(run(500.11, south(mid)).outcome).toBe('within-class-range');
    const exposed = run(500.09, south(mid));
    expect(exposed.outcome).toBe('exposed');
    expect(exposed.comparison?.levelAboveSurfaceLowerBound).toBeCloseTo(-0.01, 9);
  });

  it('open-ended class: exposed below T + 0.25, otherwise cannot be cleared', () => {
    expect(run(500.2, south(CODE['depth-gt-0.25'])).outcome).toBe('exposed');
    expect(run(510, south(CODE['depth-gt-0.25'])).outcome).toBe('open-ended-class');
    expect(run(510, south(CODE.watercourse)).outcome).toBe('open-ended-class');
  });

  it('the most severe class next to the element governs', () => {
    const split = (p: MapPoint) => (p.y >= N0 ? CELL_NO_RUNOFF : p.x > E0 + 10 ? CODE['depth-gt-0.25'] : CODE['depth-0-0.1']);
    const r = run(501, split);
    expect(r.hazardClass?.id).toBe('depth-gt-0.25');
    expect(r.outcome).toBe('open-ended-class');
    expect(r.samples.byReading['depth-gt-0.25'] + r.samples.byReading['depth-0-0.1']).toBe(12);
  });

  it('uses the highest terrain among the governing samples (conservative on slopes)', () => {
    const slope: TerrainSampler = { crs: 'EPSG:2056', verticalReference: 'LN02', heightAt: (p) => 500 + 0.1 * (p.x - E0) };
    const r = run(500, south(mid), slope);
    const plan = planSamples(door(500), boxFacts([]).footprint, resolveSampling());
    const maxX = Math.max(...plan.points.map(({ point }) => point.x));
    expect(r.governingSample?.x).toBeCloseTo(maxX, 9);
    expect(r.terrainHeight).toBeCloseTo(500 + 0.1 * (maxX - E0), 9);
  });

  it('no runoff mapped when every ground sample is transparent', () => {
    const r = run(499, () => CELL_NO_RUNOFF);
    expect(r.outcome).toBe('no-runoff-mapped');
    expect(r.hazardClass).toBeNull();
  });

  it('unclassified for edge pixels, samples off the raster, glaciers and missing terrain', () => {
    expect(run(499, south(CELL_UNCLASSIFIED))).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'map-edge-blend' });
    const offRaster = checkFloodExposure(
      boxFacts([door(499)]),
      syntheticRaster(E0 - 10, N0, 80, 40, 0.5),
      flatTerrain(500),
    ).results[0];
    expect(offRaster).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'outside-raster' });
    expect(run(499, south(CODE.glacier))).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'excluded-area' });
    const noTerrain: TerrainSampler = { crs: 'EPSG:2056', verticalReference: 'LN02', heightAt: () => null };
    expect(run(499, south(mid), noTerrain)).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'no-terrain' });
  });

  it('unclassified when no ground lies outside the footprint near the element', () => {
    // A second building across a 1.5 m gap: every ring point is inside a footprint or within 1 m of one.
    const facts = boxFacts([door(499)]);
    facts.footprint.rings.push([
      { x: E0 - 50, y: N0 - 1.5 },
      { x: E0 + 70, y: N0 - 1.5 },
      { x: E0 + 70, y: N0 - 60 },
      { x: E0 - 50, y: N0 - 60 },
    ]);
    const r = checkFloodExposure(facts, raster(south(mid)), flatTerrain(500)).results[0];
    expect(r).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'no-ground-sample' });
  });

  it('an upper-estimate level can flag but not clear', () => {
    const r = run(501, south(mid), flatTerrain(500), { levelIsUpperEstimate: true, levelBasis: 'ground-storey-level' });
    expect(r.outcome).toBe('within-class-range');
    expect(r.notes.join()).toMatch(/upper estimate/);
    expect(run(500.05, south(mid), flatTerrain(500), { levelIsUpperEstimate: true }).outcome).toBe('exposed');
  });

  it('unreadable edge samples next to a class block clearing by default', () => {
    const mixed = (p: MapPoint) => (p.y >= N0 ? CELL_NO_RUNOFF : p.x > E0 + 10 ? CELL_UNCLASSIFIED : mid);
    expect(run(502, mixed).outcome).toBe('within-class-range');
    const facts = boxFacts([door(502)]);
    expect(checkFloodExposure(facts, raster(mixed), flatTerrain(500), { edgePolicy: 'note' }).results[0].outcome).toBe('clear');
  });
});

describe('result', () => {
  it('flags below-ground spaces under an exposed opening, without sizing them', () => {
    const facts = boxFacts([door(500)], {
      spaces: [
        { expressId: 50, globalId: 'sp50', name: 'Keller', storeyId: 9, floorLevel: 497 },
        { expressId: 51, globalId: 'sp51', name: 'Wohnen', storeyId: 10, floorLevel: 500.02 },
      ],
    });
    const result = checkFloodExposure(facts, raster(south(CODE['depth-0-0.1'])), flatTerrain(500.05));
    expect(result.results[0].outcome).toBe('exposed');
    expect(result.reachableBelowGround.map((r) => [r.space.expressId, r.via])).toEqual([[50, [1]]]);
    expect(result.summary).toMatchObject({ exposed: 1, clear: 0 });
  });

  it('refuses a raster or terrain in another CRS and a stated vertical datum that differs', () => {
    const facts = boxFacts([door(500)]);
    expect(() => checkFloodExposure(facts, syntheticRaster(E0, N0, 9, 9, 1, undefined, 'EPSG:21781'), flatTerrain(500))).toThrow(
      FloodCheckRefusal,
    );
    expect(() => checkFloodExposure(facts, raster(south(1)), flatTerrain(500, 'LN02', 'EPSG:4326'))).toThrow(/terrain is in EPSG:4326/);
    const lhn95 = boxFacts([door(500)]);
    lhn95.georeference.verticalDatum = 'LHN95';
    let refusal: unknown;
    try {
      checkFloodExposure(lhn95, raster(south(1)), flatTerrain(500, 'LN02'));
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toMatchObject({ code: 'vertical-datum-mismatch' });
  });

  it('accepts equivalent spellings of the vertical datum, and says when none is stated', () => {
    const stated = boxFacts([door(500)]);
    stated.georeference.verticalDatum = 'EPSG:5728';
    expect(checkFloodExposure(stated, raster(south(1)), flatTerrain(500, 'LN 02')).verticalDatum.basis).toBe('stated-and-equal');
    const unstated = checkFloodExposure(boxFacts([door(500)]), raster(south(1)), flatTerrain(500));
    expect(unstated.verticalDatum.basis).toBe('not-stated-assumed-equal');
    expect(unstated.warnings.join()).toMatch(/states no vertical datum/);
    expect(unstated.warnings.join()).toMatch(/screening/);
  });

  it('warns when the ground storey sits far from the terrain', () => {
    const result = checkFloodExposure(boxFacts([door(500)]), raster(south(1)), flatTerrain(495));
    expect(result.warnings.join()).toMatch(/ground storey level .* from the median terrain/);
  });
});
