/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { prepareFootprint } from '../src/region.js';
import { describe, expect, it } from 'vitest';
import { checkFloodExposure, type CheckOptions } from '../src/check/check.js';
import { planSamples, resolveSampling } from '../src/check/sampling.js';
import { FloodCheckRefusal } from '../src/errors.js';
import type { ModelFacts } from '../src/model/facts.js';
import { CELL_NO_RUNOFF, CELL_UNCLASSIFIED, type MapPoint, type TerrainSampler } from '../src/types.js';
import {
  boxFacts,
  candidate,
  CODE,
  CONFIRMED,
  E0,
  flatTerrain,
  N0,
  PROVENANCE,
  syntheticRaster,
  terrainFn,
  TEST_MARGIN,
  NO_OTHER_BUILDINGS,
} from './helpers.js';

/** Raster over the box building and 10 m around it, 0.5 m cells. */
const raster = (paint: (p: MapPoint) => number) => syntheticRaster(E0 - 10, N0 - 10, 80, 60, 0.5, paint);
const south = (code: number) => (p: MapPoint) => (p.y < N0 ? code : CELL_NO_RUNOFF);
const door = (level: number, over = {}) => candidate({ position: { x: E0 + 10, y: N0 }, level, ...over });
const mid = CODE['depth-0.1-0.25'];
const low = CODE['depth-0-0.1'];
/**
 * A ground-storey door at grade on the north façade, where `south()` maps no runoff: the height reference the
 * favourable outcome needs (`plausibility.ts`), with an allowance of 0 on flat ground.
 */
const refDoor = candidate({ expressId: 99, globalId: 'g99', name: 'North door', position: { x: E0 + 10, y: N0 + 10 }, level: 500 });
const withRef = (cs: Parameters<typeof boxFacts>[0], over: Parameters<typeof boxFacts>[1] = {}) => boxFacts([...cs, refDoor], over);
/** An element on the upper storey (not a ground-storey entry). */
const upper = (level: number, over = {}) => door(level, { storeyId: 11, category: 'window', ifcClass: 'IfcWindow', ...over });

/**
 * The element under test sits on the south façade but on the upper storey: the height reference is the reference door
 * alone (a raised ground-storey door would disagree with it about the terrain and leave the reference unconfirmed).
 */
function run(level: number, paint: (p: MapPoint) => number, terrain: TerrainSampler = flatTerrain(500), over = {}, options: CheckOptions = {}) {
  return checkFloodExposure(withRef([door(level, { storeyId: 11, ...over })]), raster(paint), terrain, { otherBuildings: NO_OTHER_BUILDINGS, ...options }).results[0];
}

function refusalOf(f: () => unknown): FloodCheckRefusal {
  try {
    f();
  } catch (e) {
    if (e instanceof FloodCheckRefusal) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('ground sampling', () => {
  it('reads only ring points clearly outside the footprint, around the façade', () => {
    const plan = planSamples(door(500), prepareFootprint(boxFacts([]).footprint), resolveSampling());
    expect(plan.points.length).toBe(12);
    expect(plan.points.every(({ point }) => point.y <= N0 - 1)).toBe(true);
    expect(plan.rejected).toBe(20);
    expect(plan.anchorOffset).toBe(0);
  });

  it('anchors an interior element on the nearest point of the outline and records how far it moved', () => {
    const boiler = candidate({ category: 'equipment', ifcClass: 'IfcBoiler', position: { x: E0 + 10, y: N0 + 3 }, level: 497 });
    const result = checkFloodExposure(withRef([boiler]), raster(south(low)), flatTerrain(500)).results[0];
    expect(result.anchorBasis).toBe('nearest-outline-point');
    expect(result.anchor.x).toBeCloseTo(E0 + 10, 9);
    expect(result.anchor.y).toBeCloseTo(N0, 9);
    expect(result.anchorOffset).toBeCloseTo(3, 9);
    expect(result.outcome).toBe('exposed');
  });

  it('ignores a class drawn inside the footprint (the model raised buildings 5 m)', () => {
    const inside = (p: MapPoint) => (p.x > E0 && p.x < E0 + 20 && p.y > N0 && p.y < N0 + 10 ? CODE['depth-gt-0.25'] : CELL_NO_RUNOFF);
    expect(run(499.5, inside).outcome).toBe('no-runoff-mapped');
  });
});

describe('outcomes', () => {
  it('above-mapped-class-range / within / exposed on both sides of the thresholds, with the numbers', () => {
    // T = 500, class (0.1, 0.25], margin 0.806 → exposed at z <= 500.1, favourable at z > 501.056.
    const up = run(500.25 + TEST_MARGIN + 0.01, south(mid));
    expect(up.outcome).toBe('above-mapped-class-range');
    expect(up.terrainHeight).toBe(500);
    expect(up.hazardClass?.id).toBe('depth-0.1-0.25');
    expect(up.clearanceMargin).toBeCloseTo(TEST_MARGIN, 12);
    expect(up.comparison?.levelAboveSurfaceUpperBound).toBeCloseTo(TEST_MARGIN + 0.01, 9);
    expect(run(500.25 + TEST_MARGIN - 0.01, south(mid)).outcome).toBe('within-class-range');
    expect(run(500.11, south(mid)).outcome).toBe('within-class-range');
    const exposed = run(500.09, south(mid));
    expect(exposed.outcome).toBe('exposed');
    expect(exposed.comparison?.levelAboveSurfaceLowerBound).toBeCloseTo(-0.01, 9);
  });

  it('open-ended class: exposed below T + 0.25, otherwise undecidable', () => {
    expect(run(500.2, south(CODE['depth-gt-0.25'])).outcome).toBe('exposed');
    expect(run(502, south(CODE['depth-gt-0.25'])).outcome).toBe('open-ended-class');
    expect(run(502, south(CODE.watercourse)).outcome).toBe('open-ended-class');
  });

  it('an open-ended class anywhere next to the element decides over a bounded one', () => {
    const split = (p: MapPoint) => (p.y >= N0 ? CELL_NO_RUNOFF : p.x > E0 + 10 ? CODE['depth-gt-0.25'] : low);
    const r = run(501, split);
    expect(r.hazardClass?.id).toBe('depth-gt-0.25');
    expect(r.outcome).toBe('open-ended-class');
    expect(r.classesFound.sort()).toEqual(['depth-0-0.1', 'depth-gt-0.25']);
    expect(r.samples.byReading['depth-gt-0.25'] + r.samples.byReading['depth-0-0.1']).toBe(12);
  });

  // Review finding 1: a façade along a street with a 15 % fall. 0.1–0.25 m on the downhill side (highest T 499.885,
  // water surface up to 500.135 m) and 0–0.1 m on the uphill side (T up to 500.416, water surface up to 500.516 m).
  // Comparing only the most severe class said `clear` at 500.70 and `within-class-range` at 500.40.
  describe('every classified sample with its own terrain and class (sloping street)', () => {
    const street = (p: MapPoint) => (p.y >= N0 ? CELL_NO_RUNOFF : p.x > E0 + 10.5 ? mid : low);
    const fall = terrainFn((p) => 500 - 0.15 * (p.x - E0 - 10));

    it('is not favourable at z = 500.70: 500.70 <= 500.416 + 0.1 + margin on the uphill side', () => {
      const r = run(500.7, street, fall);
      expect(r.outcome).toBe('within-class-range');
      expect(r.hazardClass?.id).toBe('depth-0-0.1');
      expect(r.terrainHeight).toBeCloseTo(500.416, 3);
      expect(r.comparison?.surfaceUpperBound).toBeCloseTo(500.516, 3);
      expect(r.drivingSample?.point.x).toBeLessThan(E0 + 10);
      expect(r.samplesCompared).toBe(12);
    });

    it('is exposed at z = 500.40: the uphill water surface (> 500.416) is above it', () => {
      const r = run(500.4, street, fall);
      expect(r.outcome).toBe('exposed');
      expect(r.hazardClass?.id).toBe('depth-0-0.1');
      expect(r.terrainHeight).toBeCloseTo(500.416, 3);
      expect(r.comparison?.levelAboveSurfaceLowerBound).toBeCloseTo(500.4 - 500.416, 3);
      expect(r.notes.join()).toMatch(/decided by depth-0-0\.1 at E .* terrain 500\.416 m/);
    });

    it('is favourable only above every sample: z > max(Ti + Ui) + margin', () => {
      const highest = Math.max(500.416 + 0.1, 499.885 + 0.25);
      expect(run(highest + TEST_MARGIN + 0.01, street, fall).outcome).toBe('above-mapped-class-range');
      expect(run(highest + TEST_MARGIN - 0.01, street, fall).outcome).toBe('within-class-range');
    });
  });

  it('no runoff mapped when every ground sample is transparent and the layer is known to render', () => {
    const r = run(499.5, () => CELL_NO_RUNOFF, flatTerrain(500), {}, { renderingConfirmation: CONFIRMED });
    expect(r.outcome).toBe('no-runoff-mapped');
    expect(r.hazardClass).toBeNull();
    expect(r.meaning.en).toMatch(/NOT a statement that the element is safe/);
  });

  // Review finding 10: an all-transparent raster is what an outage or reprocessing returns too.
  it('an entirely transparent raster without a rendering confirmation is not "no runoff mapped"', () => {
    const r = run(499.5, () => CELL_NO_RUNOFF);
    expect(r).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'layer-not-confirmed' });
    const failed = checkFloodExposure(withRef([door(499.5)]), raster(() => CELL_NO_RUNOFF), flatTerrain(500), {
      renderingConfirmation: { confirmed: false, requestUrl: 'x', detail: 'reference came back empty', retrievedAt: PROVENANCE.retrievedAt },
    });
    expect(failed.results[0].unclassifiedReason).toBe('layer-not-confirmed');
    expect(failed.warnings.join()).toMatch(/could not be confirmed to render \(reference came back empty\)/);
    // A raster with mapped runoff elsewhere shows the layer renders: transparent samples are "no runoff mapped".
    const elsewhere = (p: MapPoint) => (p.y > N0 + 15 ? low : CELL_NO_RUNOFF);
    expect(run(499.5, elsewhere).outcome).toBe('no-runoff-mapped');
  });

  it('samples outside the coverage perimeter are no data, not "no runoff"', () => {
    const coverage = (p: MapPoint) => (p.y > N0 - 2.5 ? true : p.y < N0 - 2.6 ? false : null);
    // The coverage test travels with the raster (`ClassifiedHazardRaster.covers`).
    const covered = (level: number, paint: (p: MapPoint) => number, covers: (p: MapPoint) => boolean | null, options: CheckOptions = {}) =>
      checkFloodExposure(withRef([door(level, { storeyId: 11 })]), syntheticRaster(E0 - 10, N0 - 10, 80, 60, 0.5, paint, 'EPSG:2056', covers), flatTerrain(500), options).results[0];
    const r = covered(499.5, () => CELL_NO_RUNOFF, () => false, { renderingConfirmation: CONFIRMED });
    expect(r).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'outside-coverage' });
    // Mixed: the samples inside coverage carry a class; the unreadable rest withholds the favourable outcome.
    const mixed = covered(503, south(low), coverage);
    expect(mixed.outcome).toBe('within-class-range');
    expect(mixed.samples.byReading['outside-coverage']).toBeGreaterThan(0);
    expect(mixed.favourableWithheldBecause.join()).toMatch(/outside, or too near the edge of, the area the map covers/);
  });

  it('unclassified for edge pixels, samples off the raster, glaciers and missing terrain', () => {
    expect(run(499.5, south(CELL_UNCLASSIFIED))).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'map-edge-blend' });
    const offRaster = checkFloodExposure(withRef([door(499.5)]), syntheticRaster(E0 - 10, N0, 80, 40, 0.5), flatTerrain(500)).results[0];
    expect(offRaster).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'outside-raster' });
    expect(run(499.5, south(CODE.glacier))).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'excluded-area' });
    const noTerrain = terrainFn(() => null);
    expect(run(499.5, south(mid), noTerrain)).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'no-terrain' });
  });

  it('unclassified when no ground lies outside the footprint near the element', () => {
    // A second building across a 1.5 m gap: every ring point is inside a footprint or within 1 m of one.
    const facts = withRef([door(499.5)]);
    facts.footprint.rings.push([
      { x: E0 - 50, y: N0 - 1.5 },
      { x: E0 + 70, y: N0 - 1.5 },
      { x: E0 + 70, y: N0 - 60 },
      { x: E0 - 50, y: N0 - 60 },
    ]);
    const r = checkFloodExposure(facts, raster(south(mid)), flatTerrain(500)).results[0];
    expect(r).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'no-ground-sample' });
  });

  it('an upper-estimate level can flag but not be favourable', () => {
    const r = run(502, south(mid), flatTerrain(500), { levelIsUpperEstimate: true, levelBasis: 'given' });
    expect(r.outcome).toBe('within-class-range');
    expect(r.favourableWithheldBecause.join()).toMatch(/upper estimate/);
    expect(run(500.05, south(mid), flatTerrain(500), { levelIsUpperEstimate: true }).outcome).toBe('exposed');
  });

  // Review finding 7: the real entry of an external stair or ramp is at the terrain.
  it('an entry at terrain is exposed wherever any depth class is mapped, even below the ground storey', () => {
    const stair = { category: 'stair', levelBasis: 'ground-storey-or-terrain', levelIsUpperEstimate: true } as const;
    const r = run(500.5, south(low), flatTerrain(500), stair);
    expect(r.outcome).toBe('exposed');
    expect(r.drivingSample?.level).toBe(500);
    expect(r.notes.join()).toMatch(/entry is at terrain/);
    // Terrain above the ground storey: the ground storey level is the entry, and 500.5 <= 500.6 + 0 is exposed too.
    expect(run(500.5, south(low), flatTerrain(500.6), stair).outcome).toBe('exposed');
  });

  it('unreadable edge samples next to a class withhold the favourable outcome', () => {
    const mixed = (p: MapPoint) => (p.y >= N0 ? CELL_NO_RUNOFF : p.x > E0 + 10 ? CELL_UNCLASSIFIED : mid);
    expect(run(502, mixed).outcome).toBe('within-class-range');
  });

  // Review finding 6: a courtyard door moved to the outer hull samples the street side.
  it('no favourable outcome when the element had to be moved onto the outline, or the footprint is a hull', () => {
    const inner = candidate({ position: { x: E0 + 10, y: N0 + 3 }, level: 503 });
    const moved = checkFloodExposure(withRef([inner]), raster(south(low)), flatTerrain(500)).results[0];
    expect(moved.anchorOffset).toBeCloseTo(3, 9);
    expect(moved.outcome).toBe('within-class-range');
    expect(moved.favourableWithheldBecause.join()).toMatch(/3\.00 m inside the footprint outline/);
    // Second-round finding 4: a wider tolerance would bring the favourable outcome back; it may only be lowered.
    expect(() => checkFloodExposure(withRef([inner]), raster(south(low)), flatTerrain(500), { anchorTolerance: 5 })).toThrow(/may only be lowered/);

    const hull = withRef([door(503)]);
    hull.footprint.source = 'external-wall-hull';
    const onHull = checkFloodExposure(hull, raster(south(low)), flatTerrain(500)).results[0];
    expect(onHull.outcome).toBe('within-class-range');
    expect(onHull.favourableWithheldBecause.join()).toMatch(/external-wall-hull/);
  });
});

// PR review threads.
describe('review threads', () => {
  it('a glacier sample next to a shallow class withholds the favourable outcome', () => {
    const split = (p: MapPoint) => (p.y >= N0 ? CELL_NO_RUNOFF : p.x > E0 + 10 ? CODE.glacier : low);
    const r = run(501, split);
    expect(r.outcome).toBe('within-class-range');
    expect(r.favourableWithheldBecause.join()).toMatch(/did not model/);
  });

  it('one classified sample without terrain withholds the favourable outcome', () => {
    const holey = terrainFn((p) => (p.x > E0 + 11 ? null : 500));
    const r = run(501.5, south(low), holey);
    expect(r.outcome).toBe('within-class-range');
    expect(r.favourableWithheldBecause.join()).toMatch(/have no terrain height/);
  });

  it('only entry points, not equipment, make below-ground spaces reachable', () => {
    const boiler = candidate({ category: 'equipment', ifcClass: 'IfcBoiler', position: { x: E0 + 10, y: N0 }, level: 500 });
    const facts = withRef([boiler], { spaces: [{ expressId: 50, globalId: 'sp50', name: 'Keller', storeyId: 9, floorLevel: 497 }] });
    const result = checkFloodExposure(facts, raster(south(low)), flatTerrain(500.05));
    expect(result.results[0].outcome).toBe('exposed');
    expect(result.reachableBelowGround).toEqual([]);
  });

  it('rejects a negative or NaN margin instead of reporting with it', () => {
    expect(() => checkFloodExposure(withRef([door(500.15)]), raster(south(mid)), flatTerrain(500), { clearanceMargin: -0.5 })).toThrow(RangeError);
    expect(() => checkFloodExposure(withRef([door(500.15)]), raster(south(mid)), flatTerrain(500), { clearanceMargin: Number.NaN })).toThrow(RangeError);
  });
});

// Review finding 4.
describe('clearance margin', () => {
  it('is max(0.5, 2 * sqrt(sigmaT^2 + 0.25^2 + sigmaGeo^2)) and recorded with its numbers', () => {
    const r = checkFloodExposure(withRef([door(502)]), raster(south(mid)), flatTerrain(500, 'EPSG:5728', 'EPSG:2056', 0.5));
    expect(r.margin.margin).toBeCloseTo(2 * Math.sqrt(0.25 + 0.0625 + 0.25), 12);
    expect(r.margin.statement).toMatch(/max\(0\.5, 2 \* sqrt\(0\.5\^2 \+ 0\.25\^2 \+ 0\.5\^2\)\) = max\(0\.5, 1\.5\) = 1\.5 m/);
    expect(r.margin).toMatchObject({ georeferenceVerticalUncertainty: 0.5, georeferenceBasis: 'default-not-surveyed' });
    expect(r.warnings.join()).toMatch(/not stated to be surveyed, so the margin assumes 0\.5 m/);
    // A caller who knows the height reference is surveyed states it: supplying information.
    const surveyed = checkFloodExposure(withRef([door(502)]), raster(south(mid)), flatTerrain(500, 'EPSG:5728', 'EPSG:2056', 0.5), {
      georeferenceVerticalUncertainty: 0.1,
    });
    expect(surveyed.margin.margin).toBeCloseTo(2 * Math.sqrt(0.25 + 0.0625 + 0.01), 12);
    expect(surveyed.margin.georeferenceBasis).toBe('stated-by-caller');
    // The class resolution may only be raised.
    expect(() => checkFloodExposure(withRef([door(502)]), raster(south(mid)), flatTerrain(500), { classResolution: 0.05 })).toThrow(/may only be raised/);
    // A caller may raise it but not lower it.
    const raised = checkFloodExposure(withRef([door(502)]), raster(south(mid)), flatTerrain(500), { clearanceMargin: 2 });
    expect(raised.margin.margin).toBe(2);
    const lowered = checkFloodExposure(withRef([door(502)]), raster(south(mid)), flatTerrain(500), { clearanceMargin: 0.1 });
    expect(lowered.margin.margin).toBeCloseTo(TEST_MARGIN, 12);
  });

  it('without a stated terrain accuracy nothing is reported above the mapped class range', () => {
    const unknown = flatTerrain(500, 'EPSG:5728', 'EPSG:2056', null);
    const result = checkFloodExposure(withRef([door(510)]), raster(south(mid)), unknown);
    expect(result.margin.margin).toBeNull();
    expect(result.results[0]).toMatchObject({ outcome: 'within-class-range', clearanceMargin: null });
    expect(result.results[0].favourableWithheldBecause.join()).toMatch(/states no vertical accuracy/);
    expect(result.warnings.join()).toMatch(/Clearance margin not sized/);
    // Exposure does not need a margin.
    expect(checkFloodExposure(withRef([door(500.05)]), raster(south(mid)), unknown).results[0].outcome).toBe('exposed');
  });
});

// Review finding 2.
describe('height reference plausibility', () => {
  const at = (ground: number, level = ground): ModelFacts =>
    withRef([door(level)], { groundStorey: { expressId: 10, level: ground, basis: 'given' } });

  it('refuses a model whose OrthogonalHeight is 0 with terrain at 500 m (it made every element exposed)', () => {
    const e = refusalOf(() => checkFloodExposure(at(0), raster(south(low)), flatTerrain(500)));
    expect(e.code).toBe('georeference-implausible');
    expect(e.message).toMatch(/0\.00 m, 500\.00 m below the lowest terrain sampled around the building \(500\.00 m at E /);
    expect(e.message).toMatch(/height-reference error in the model, not flood exposure.*OrthogonalHeight.*vertical datum.*groundStorey/);
  });

  it('refuses a model placed 40 m too high (it made every element favourable)', () => {
    const e = refusalOf(() => checkFloodExposure(at(540), raster(south(low)), flatTerrain(500)));
    expect(e.code).toBe('georeference-implausible');
    expect(e.message).toMatch(/40\.00 m above the highest terrain/);
  });

  it('checks the terrain at every ring point, also where no class is mapped', () => {
    const e = refusalOf(() => checkFloodExposure(at(0), raster(() => CELL_NO_RUNOFF), flatTerrain(500)));
    expect(e.code).toBe('georeference-implausible');
  });

  it('accepts a walk-out basement on a hillside and records the basis', () => {
    // Terrain rises 4 m across the building from south (499) to north (503): the ground floor at the uphill grade.
    const hill = terrainFn((p) => 499 + 0.25 * (p.y - (N0 - 3)));
    const facts = withRef(
      [door(503.2), candidate({ expressId: 2, position: { x: E0 + 10, y: N0 + 10 }, level: 503.2 })],
      { groundStorey: { expressId: 10, level: 503.2, basis: 'given' } },
    );
    const r = checkFloodExposure(facts, raster(south(low)), hill);
    expect(r.heightPlausibility.status).toBe('within-band');
    expect(r.heightPlausibility.terrainMin).toBeCloseTo(499, 6);
    expect(r.heightPlausibility.terrainMax).toBeCloseTo(503, 6);
    expect(r.heightPlausibility.statement).toMatch(/ground storey 503\.20 m within \[499\.00 - 1\.5, .* \+ 2\.5\] m/);
  });

  it('takes the band as an option and still refuses outside it', () => {
    expect(checkFloodExposure(at(503.5), raster(south(low)), flatTerrain(500), { heightPlausibility: { above: 4 } }).heightPlausibility.status).toBe('within-widened-band');
    expect(refusalOf(() => checkFloodExposure(at(503.5), raster(south(low)), flatTerrain(500))).code).toBe('georeference-implausible');
    expect(() => checkFloodExposure(at(500), raster(south(low)), flatTerrain(500), { heightPlausibility: { below: -1 } })).toThrow(RangeError);
  });
});

describe('result', () => {
  it('flags below-ground spaces under an exposed opening, without sizing them', () => {
    const facts = withRef([door(500)], {
      spaces: [
        { expressId: 50, globalId: 'sp50', name: 'Keller', storeyId: 9, floorLevel: 497 },
        { expressId: 51, globalId: 'sp51', name: 'Wohnen', storeyId: 10, floorLevel: 500.02 },
      ],
    });
    const result = checkFloodExposure(facts, raster(south(low)), flatTerrain(500.05));
    expect(result.results[0].outcome).toBe('exposed');
    expect(result.reachableBelowGround.map((r) => [r.space.expressId, r.via])).toEqual([[50, [1]]]);
    expect(result.summary).toMatchObject({ exposed: 1, 'above-mapped-class-range': 0 });
  });

  it('carries what the outcome means and the screening caveat on every result', () => {
    const result = checkFloodExposure(withRef([upper(503)]), raster(south(low)), flatTerrain(500));
    const r = result.results[0];
    expect(r.outcome).toBe('above-mapped-class-range');
    expect(r.meaning.en).toMatch(/rarer events, and runoff the map does not show, are not covered/);
    expect(r.caveat.en).toMatch(/Screening result from "Test" \(dataset date 2018-05-22\), a map not intended for use at building scale/);
    expect(r.caveat.en).toMatch(/may still be affected.*IfcLite_SurfaceRunoffHazardSite.*test attribution/);
    expect(r.caveat.de).toMatch(/nicht für den Gebäudemassstab bestimmt/);
    expect(result.caveat).toEqual(r.caveat);
  });

  it('refuses a raster or terrain in another CRS, and a stated vertical CRS that differs by EPSG code', () => {
    const facts = withRef([door(500)]);
    expect(() => checkFloodExposure(facts, syntheticRaster(E0, N0, 9, 9, 1, undefined, 'EPSG:21781'), flatTerrain(500))).toThrow(FloodCheckRefusal);
    expect(() => checkFloodExposure(facts, raster(south(1)), flatTerrain(500, 'EPSG:5728', 'EPSG:4326'))).toThrow(/terrain is in EPSG:4326/);
    const lhn95 = withRef([door(500)]);
    lhn95.georeference.verticalDatum = 'LHN95';
    expect(refusalOf(() => checkFloodExposure(lhn95, raster(south(1)), flatTerrain(500))).code).toBe('vertical-datum-mismatch');
  });

  // Review finding 9: datums are matched on an EPSG identifier, not free text.
  it('matches vertical CRSs by EPSG identifier and refuses names it cannot identify', () => {
    const stated = withRef([door(500)]);
    stated.georeference.verticalDatum = 'Landesnivellement 1902';
    const r = checkFloodExposure(stated, raster(south(1)), flatTerrain(500, 'urn:ogc:def:crs:EPSG::5728'));
    expect(r.verticalDatum).toMatchObject({ basis: 'stated-and-equal', modelCrs: 'EPSG:5728', terrainCrs: 'EPSG:5728' });
    const free = withRef([door(500)]);
    free.georeference.verticalDatum = 'Höhe über Meer';
    expect(refusalOf(() => checkFloodExposure(free, raster(south(1)), flatTerrain(500))).code).toBe('vertical-datum-unrecognised');
    // A terrain that names its datum only in words is refused: the comparison needs a code.
    expect(refusalOf(() => checkFloodExposure(withRef([door(500)]), raster(south(1)), flatTerrain(500, 'LN02'))).code).toBe(
      'vertical-datum-unrecognised',
    );
    const unstated = checkFloodExposure(withRef([door(500)]), raster(south(1)), flatTerrain(500));
    expect(unstated.verticalDatum.basis).toBe('not-stated-assumed-equal');
    expect(unstated.warnings.join()).toMatch(/states no vertical datum.*EPSG:5728/);
    expect(unstated.warnings.join()).toMatch(/screening/);
  });
});
