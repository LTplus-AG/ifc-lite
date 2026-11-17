/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inputs that used to yield a reassuring outcome the data does not support
 * (second review round of the decision logic). Each test is the reported input.
 */

import { describe, expect, it } from 'vitest';
import { checkFloodExposure, type CheckOptions, type FloodCheckResult } from '../src/check/check.js';
import { runFloodCheck } from '../src/check/run.js';
import { readCell } from '../src/check/sampling.js';
import { FloodCheckRefusal } from '../src/errors.js';
import type { CandidateFact } from '../src/model/facts.js';
import { CELL_NO_RUNOFF, CELL_UNCLASSIFIED, type HazardProvider, type MapPoint, type TerrainSampler } from '../src/types.js';
import { boxFacts, candidate, CODE, CONFIRMED, E0, flatTerrain, N0, syntheticRaster, terrainFn, TEST_MARGIN, NO_OTHER_BUILDINGS } from './helpers.js';

const raster = (paint: (p: MapPoint) => number) => syntheticRaster(E0 - 10, N0 - 10, 80, 60, 0.5, paint);
const south = (code: number) => (p: MapPoint) => (p.y < N0 ? code : CELL_NO_RUNOFF);
const mid = CODE['depth-0.1-0.25'];
const low = CODE['depth-0-0.1'];

const groundDoor = (level: number, over: Partial<CandidateFact> = {}) =>
  candidate({ position: { x: E0 + 10, y: N0 }, level, storeyId: 10, ...over });
const upperWindow = (level: number, over: Partial<CandidateFact> = {}) =>
  candidate({ expressId: 3, category: 'window', ifcClass: 'IfcWindow', position: { x: E0 + 5, y: N0 }, level, storeyId: 11, ...over });

function check(cs: CandidateFact[], ground: number, paint: (p: MapPoint) => number, terrain: TerrainSampler, options: CheckOptions = {}) {
  return checkFloodExposure(boxFacts(cs, { groundStorey: { expressId: 10, level: ground, basis: 'given' } }), raster(paint), terrain, { otherBuildings: NO_OTHER_BUILDINGS, ...options });
}

/** Either a refusal, or results none of which is favourable. */
function noFavourable(f: () => FloodCheckResult): FloodCheckResult | FloodCheckRefusal {
  try {
    const r = f();
    expect(r.results.map((x) => x.outcome)).not.toContain('above-mapped-class-range');
    return r;
  } catch (e) {
    if (e instanceof FloodCheckRefusal) return e;
    throw e;
  }
}

// Finding 1: a model placed too high, within the building-level band, came out favourable.
describe('a model placed too high is not reported favourable', () => {
  // Terrain at the doors' rings rises from 500 m (south) to 510 m (north); real ground floor 500 m, north entry on the
  // upper storey at 510 m; the south side carries the 0.1–0.25 m class.
  const slope = terrainFn((p) => 500 + (10 * (p.y - (N0 - 2))) / 14);
  const building = (k: number) => [
    groundDoor(500 + k),
    candidate({ expressId: 2, position: { x: E0 + 10, y: N0 + 10 }, level: 510 + k, storeyId: 11 }),
    upperWindow(503 + k),
  ];

  it('the correct model: the south door is exposed and the upper window is favourable', () => {
    const r = check(building(0), 500, south(mid), slope);
    expect(r.heightReference).toMatchObject({ status: 'confirmed', allowance: 0 });
    expect(r.results[0].outcome).toBe('exposed');
    expect(r.results[2].outcome).toBe('above-mapped-class-range');
  });

  for (const k of [3, 5, 7, 10, 11]) {
    it(`on the 500→510 m slope, ${k} m too high: no element is favourable and the result set says why`, () => {
      const r = noFavourable(() => check(building(k), 500 + k, south(mid), slope));
      expect(r).not.toBeInstanceOf(FloodCheckRefusal);
      const result = r as FloodCheckResult;
      expect(result.heightReference.status).toBe('unconfirmed');
      expect(result.heightReference.unconfirmedBecause.join()).toMatch(/ground-storey door #1 sits .* above the terrain next to it/);
      expect(result.results[0].favourableWithheldBecause.join()).toMatch(/height reference .* could not be confirmed/);
      expect(result.results[0].residualRisk.en).toMatch(/cannot be verified from the hazard map.*No element is reported above the mapped class range/);
    });
  }

  it('on a 1:10 slope, 4 m too high (inside the building-level band of a 30 m deep building): not favourable', () => {
    const tenth = terrainFn((p) => 500 + 0.1 * (p.y - N0));
    const deep = (k: number) => {
      const facts = boxFacts(
        [groundDoor(500 + k), groundDoor(503 + k, { expressId: 2, position: { x: E0 + 10, y: N0 + 30 } })],
        { groundStorey: { expressId: 10, level: 500 + k, basis: 'given' } },
      );
      facts.footprint.rings = [[{ x: E0, y: N0 }, { x: E0 + 20, y: N0 }, { x: E0 + 20, y: N0 + 30 }, { x: E0, y: N0 + 30 }]];
      return checkFloodExposure(facts, syntheticRaster(E0 - 10, N0 - 10, 80, 100, 0.5, south(mid)), tenth);
    };
    expect(deep(0).heightReference.status).toBe('confirmed');
    const r = deep(4);
    expect(r.heightPlausibility.status).toBe('within-band');
    expect(r.heightReference.status).toBe('unconfirmed');
    expect(r.results.map((x) => x.outcome)).not.toContain('above-mapped-class-range');
    expect(r.results[0].outcome).toBe('within-class-range');
  });

  it('on flat ground, 2.4 m too high (below the 2.5 m entry tolerance): the allowance withholds the favourable outcome', () => {
    const r = check([groundDoor(502.4), upperWindow(504.4)], 502.4, south(mid), flatTerrain(500));
    expect(r.heightReference.status).toBe('confirmed');
    expect(r.heightReference.allowance).toBeCloseTo(2.4, 9);
    expect(r.results[0].outcome).toBe('within-class-range');
    expect(r.results[0].favourableWithheldBecause.join()).toMatch(/not by the further 2\.40 m height-reference allowance/);
    // 504.4 - 2.4 = 502.0 still clears 500.25 + margin: an upper window far enough above stays favourable.
    expect(r.results[1].outcome).toBe('above-mapped-class-range');
    expect(r.results[1].residualRisk.en).toMatch(/up to 2\.5 m .* 2\.40 m more clearance/);
  });

  it('without any ground-storey door nothing is favourable', () => {
    const r = check([upperWindow(505)], 500, south(low), flatTerrain(500));
    expect(r.heightReference.unconfirmedBecause.join()).toMatch(/no door on the footprint outline/);
    expect(r.results[0].outcome).toBe('within-class-range');
  });

  it('the entry tolerance and the georeferencing term cannot be loosened without stating information', () => {
    expect(() => check([groundDoor(500)], 500, south(low), flatTerrain(500), { heightPlausibility: { entryAbove: 5 } })).toThrow(/may only be lowered/);
    // Widening the building-level band yields results, but none favourable.
    const widened = check([groundDoor(500.2), upperWindow(506)], 503.5, south(low), flatTerrain(500), { heightPlausibility: { above: 4 } });
    expect(widened.heightPlausibility.status).toBe('within-widened-band');
    expect(widened.heightReference.status).toBe('unconfirmed');
    expect(widened.results[1].outcome).toBe('within-class-range');
    // The margin assumes an unsurveyed height reference unless told otherwise.
    expect(widened.margin.georeferenceBasis).toBe('default-not-surveyed');
    expect(TEST_MARGIN).toBeCloseTo(1.269, 3);
  });
});

// Finding 2: terrain sampled only next to the candidates refused a hillside building whose candidates are all uphill.
describe('the building-level band sees the whole footprint', () => {
  it('accepts a hillside building with candidates only on the uphill side', () => {
    const hill = terrainFn((p) => 500 + 0.8 * (p.y - N0));
    const north = candidate({ category: 'window', ifcClass: 'IfcWindow', position: { x: E0 + 10, y: N0 + 10 }, level: 509, storeyId: 11 });
    const r = check([north], 500, () => CELL_NO_RUNOFF, hill, { renderingConfirmation: CONFIRMED });
    expect(r.heightPlausibility.status).toBe('within-band');
    expect(r.heightPlausibility.terrainMin).toBeCloseTo(498.4, 6);
    expect(r.heightPlausibility.statement).toMatch(/along the footprint outline and next to the elements/);
    // Not refused, but no ground-storey door confirms the height reference: no reassuring outcome.
    expect(r.results[0]).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'height-reference-unconfirmed' });
  });
});

// Finding 3: "no runoff mapped" ignored the anchor and hull conditions.
describe('"no runoff mapped" is guarded like the favourable outcome', () => {
  const clear = () => CELL_NO_RUNOFF;
  const ref = groundDoor(500, { expressId: 99, position: { x: E0 + 10, y: N0 + 10 } });

  it('an interior element moved 5 m to reach the outline is unclassified (anchor-moved)', () => {
    const boiler = candidate({ category: 'equipment', ifcClass: 'IfcBoiler', position: { x: E0 + 10, y: N0 + 5 }, level: 500 });
    const r = check([boiler, ref], 500, clear, flatTerrain(500), { renderingConfirmation: CONFIRMED });
    expect(r.results[0].anchorOffset).toBeCloseTo(5, 9);
    expect(r.results[0]).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'anchor-moved' });
    expect(r.results[0].favourableWithheldBecause.join()).toMatch(/5\.00 m inside the footprint outline/);
    expect(r.results[1].outcome).toBe('no-runoff-mapped');
  });

  it('an element on a hull footprint is unclassified (hull-footprint)', () => {
    const facts = boxFacts([groundDoor(500)]);
    facts.footprint.source = 'external-wall-hull';
    const r = checkFloodExposure(facts, raster(clear), flatTerrain(500), { renderingConfirmation: CONFIRMED, otherBuildings: NO_OTHER_BUILDINGS });
    expect(r.results[0]).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'hull-footprint' });
  });

  it('an unconfirmed height reference, an upper-estimate level and an unsized margin each withhold it', () => {
    const r = check([groundDoor(503)], 500, clear, flatTerrain(500), { renderingConfirmation: CONFIRMED });
    expect(r.results[0]).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'height-reference-unconfirmed' });
    const stair = groundDoor(500, { expressId: 2, category: 'stair', levelBasis: 'ground-storey-or-terrain', levelIsUpperEstimate: true });
    expect(check([stair, ref], 500, clear, flatTerrain(500), { renderingConfirmation: CONFIRMED }).results[0].unclassifiedReason).toBe('level-upper-estimate');
    const unknown = flatTerrain(500, 'EPSG:5728', 'EPSG:2056', null);
    expect(check([groundDoor(500)], 500, clear, unknown, { renderingConfirmation: CONFIRMED }).results[0].unclassifiedReason).toBe('margin-not-sized');
  });
});

// Finding 4: edgePolicy 'note' brought the favourable outcome back.
describe('no option makes an outcome more favourable', () => {
  it('5 edge-pixel samples plus 7 shallow-class samples are not favourable, whatever edgePolicy says', () => {
    const anchor = { x: E0 + 10, y: N0 };
    const paint = (p: MapPoint) => (p.y >= N0 ? CELL_NO_RUNOFF : Math.hypot(p.x - anchor.x, p.y - anchor.y) < 2.5 ? CELL_UNCLASSIFIED : low);
    const ref = groundDoor(500, { expressId: 99, position: { x: E0 + 10, y: N0 + 10 } });
    const options = { edgePolicy: 'note' } as unknown as CheckOptions;
    const r = check([groundDoor(502), ref], 500, paint, flatTerrain(500), options).results[0];
    expect(r.samples.byReading.unclassified).toBe(5);
    expect(r.samples.byReading['depth-0-0.1']).toBe(7);
    expect(r.outcome).toBe('within-class-range');
    expect(r.favourableWithheldBecause.join()).toMatch(/5 ground sample\(s\) are unreadable edge pixels/);
  });

  it('refuses options that would loosen a tolerance', () => {
    const facts = boxFacts([groundDoor(500)]);
    expect(() => checkFloodExposure(facts, raster(south(low)), flatTerrain(500), { anchorTolerance: 1.5 })).toThrow(/may only be lowered/);
    expect(() => checkFloodExposure(facts, raster(south(low)), flatTerrain(500), { classResolution: 0.1 })).toThrow(/may only be raised/);
    expect(checkFloodExposure(facts, raster(south(low)), flatTerrain(500), { anchorTolerance: 0.5 }).parameters.anchorTolerance).toBe(0.5);
  });
});

// PR review threads on the second round.
describe('review threads', () => {
  const ref = groundDoor(500, { expressId: 99, position: { x: E0 + 10, y: N0 + 10 } });
  /** Transparent everywhere except one unreadable edge pixel far from the building. */
  const oneEdgePixel = (p: MapPoint) => (p.x < E0 - 9 && p.y > N0 + 19 ? CELL_UNCLASSIFIED : CELL_NO_RUNOFF);

  it('a raster of transparent cells and one edge pixel needs the rendering confirmation like an empty one', async () => {
    const unconfirmed = check([groundDoor(500), ref], 500, oneEdgePixel, flatTerrain(500));
    expect(unconfirmed.layerCheck.rasterEmpty).toBe(true);
    expect(unconfirmed.results[0]).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'layer-not-confirmed' });
    const confirmed = check([groundDoor(500), ref], 500, oneEdgePixel, flatTerrain(500), { renderingConfirmation: CONFIRMED });
    expect(confirmed.results[0].outcome).toBe('no-runoff-mapped');

    // runFloodCheck asks the provider for the confirmation on such a raster.
    let asked = 0;
    const provider: HazardProvider = {
      id: 'stub',
      crs: 'EPSG:2056',
      classes: raster(oneEdgePixel).classes,
      extent: { minX: 2_000_000, minY: 1_000_000, maxX: 3_000_000, maxY: 1_400_000 },
      modelCellSize: 1,
      fetchRaster: async () => raster(oneEdgePixel),
      confirmRendering: async () => {
        asked++;
        return CONFIRMED;
      },
    };
    const terrain = { crs: 'EPSG:2056', verticalCrs: 'EPSG:5728', verticalAccuracy: 0.3, heightAt: () => 500 };
    const run = await runFloodCheck(boxFacts([groundDoor(500), ref]), provider, terrain, { otherBuildings: NO_OTHER_BUILDINGS });
    expect(asked).toBe(1);
    expect(run.layerCheck.confirmation?.confirmed).toBe(true);
  });

  it('a non-finite ground-storey level is refused, never read as inside the band', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const e = (() => {
        try {
          check([groundDoor(500), ref], bad, south(mid), flatTerrain(500), { renderingConfirmation: CONFIRMED });
        } catch (err) {
          return err;
        }
      })();
      expect(e).toBeInstanceOf(FloodCheckRefusal);
      expect((e as FloodCheckRefusal).code).toBe('georeference-implausible');
    }
  });

  it('a candidate with a non-finite level is refused, whatever its category: no favourable result from an Infinity level', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      for (const cs of [[groundDoor(bad), upperWindow(503)], [groundDoor(500), upperWindow(bad)]]) {
        const e = (() => {
          try {
            check(cs, 500, south(mid), flatTerrain(500), { renderingConfirmation: CONFIRMED });
          } catch (err) {
            return err;
          }
        })();
        expect(e).toBeInstanceOf(FloodCheckRefusal);
        expect((e as FloodCheckRefusal).code).toBe('georeference-implausible');
      }
    }
  });

  it('a sample on a row boundary reads the row whose closed north edge it is, as the raster contract says', () => {
    // Two rows of 1 m with origin y = 2: row 0 covers (1, 2], row 1 covers (0, 1]. y = 1 is row 1's north edge.
    const r = syntheticRaster(0, 0, 1, 2, 1, (p) => (p.y > 1 ? low : mid));
    expect(readCell(r, { x: 0.5, y: 1 })).toEqual({ kind: 'class', code: mid });
    expect(readCell(r, { x: 0.5, y: 2 })).toEqual({ kind: 'class', code: low });
    expect(readCell(r, { x: 0.5, y: 1.5 })).toEqual({ kind: 'class', code: low });
    expect(readCell(r, { x: 0.5, y: 0 })).toEqual({ kind: 'outside' });
    expect(readCell(r, { x: 0.5, y: 2.01 })).toEqual({ kind: 'outside' });
  });
});

// Review round on head 4239cce5: an empty caller footprint was trusted as a 'given' outline with no rings.
describe('an empty footprint option', () => {
  it('is refused, not read as a building with no outline whose interior samples count as ground', async () => {
    const { extractModelFacts } = await import('../src/model/extract.js');
    const { parseStep, syntheticHouse } = await import('./synthetic-model.js');
    const store = await parseStep(syntheticHouse({ verticalDatum: 'LN02' }));
    expect(() => extractModelFacts(store, { expectedCrs: 'EPSG:2056', footprint: [] })).toThrow(RangeError);
    expect(() => extractModelFacts(store, { expectedCrs: 'EPSG:2056', footprint: [[{ x: 2_600_000, y: 1_200_000 }, { x: 2_600_010, y: 1_200_000 }]] })).toThrow(RangeError);
  }, 15_000);

  it('hand-built facts with no footprint rings get no reassuring outcome', () => {
    const facts = boxFacts([groundDoor(500), candidate({ expressId: 4, category: 'equipment', ifcClass: 'IfcBoiler', position: { x: E0 + 10, y: N0 + 5 }, level: 497, storeyId: 9 })], {
      footprint: { rings: [], source: 'given', fromElements: [] },
    });
    const r = checkFloodExposure(facts, raster(() => CELL_NO_RUNOFF), flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
    for (const x of r.results) expect(['no-runoff-mapped', 'above-mapped-class-range']).not.toContain(x.outcome);
  });
});
