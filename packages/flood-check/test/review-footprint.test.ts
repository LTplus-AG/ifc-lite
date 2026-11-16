/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The automated review of #10403 at c4a5a8d0f: a footprint that cannot know
 * its ground level, a readable slab left out, a given footprint's small inner
 * ring, and the third instance of one class: two queries holding different
 * ideas of where the building is. The class is closed by one prepared
 * footprint (`region.ts`); the sweep below checks that its queries agree.
 */

import { describe, expect, it } from 'vitest';
import { extractModelFacts } from '../src/model/extract.js';
import { closestOutlinePoint, insideFootprint, outsideBy, prepareFootprint, signedDistance, type PreparedFootprint } from '../src/region.js';
import * as geom from '../src/geom.js';
import type { MapPoint } from '../src/types.js';
import { mapOf, parseStep, syntheticHouse, type Extra } from './synthetic-model.js';

const E0 = 2_600_000;
const N0 = 1_200_000;
const P = (x: number, y: number): MapPoint => ({ x: E0 + x, y: N0 + y });
const rect = (x0: number, y0: number, x1: number, y1: number) => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
const local = (pts: Array<[number, number]>) => pts.map(([x, y]) => mapOf(x, y));

/** Two room slabs 9.9 m wide with a 0.2 m gap under an interior wall at x = 10 (repro G), and `extra`. */
const roomSlabs = (extra: (b: Extra) => void = () => {}) => (b: Extra) => {
  for (const [x, name] of [[4.95, 'West'], [15.05, 'Ost']] as const) {
    b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Raum ${name}',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([b.rectExtrusion(x, 5, 9.9, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1))])},$,.FLOOR.)`));
  }
  extra(b);
};
const extract = async (extra: (b: Extra) => void, slab = true) =>
  extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', slab, extra })), { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });

describe('finding 1: with no storey, no slab is known to be at ground level', () => {
  it('a single-building file without IfcBuildingStorey gives a partial footprint, never a complete one', async () => {
    const text = syntheticHouse({
      verticalDatum: 'LN02',
      extra: (b) => {
        // A cantilevered upper-floor slab reaching 3 m beyond the south façade.
        b.contain(b.storeys.og.id, b.add(`IFCSLAB(${b.guid()},$,'Decke OG Auskragung',$,$,#${b.place(b.storeys.og.pl, 0, 0, 0)},#${b.shape([b.rectExtrusion(10, 3.5, 20, 13, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1))])},$,.FLOOR.)`));
      },
    }).replace(/IFCBUILDINGSTOREY\((.*),([^,]*)\);/g, 'IFCSPACE($1,.INTERNAL.,$);');
    const facts = extractModelFacts(await parseStep(text), { expectedCrs: 'EPSG:2056' });
    expect(facts.storeys).toHaveLength(0);
    expect(facts.footprint.partial).toBe(true);
    expect(facts.footprint.quality?.notes.join()).toMatch(/no storey identifies the ground level/);
  });
});

describe('finding 2: a readable slab left out of the outline is recorded', () => {
  it('a 0.8 m² ground-storey slab beside the house makes the footprint partial and is listed as not used, not in fromElements', async () => {
    let small = 0;
    const facts = await extract((b) => {
      small = b.add(`IFCSLAB(${b.guid()},$,'Podest',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([b.rectExtrusion(21, 5, 0.8, 1, 0.2, b.axis(0, 0, 0), b.dir(0, 0, -1))])},$,.FLOOR.)`);
      b.contain(b.storeys.eg.id, small);
    });
    expect(facts.footprint.partial).toBe(true);
    expect(facts.footprint.fromElements).not.toContain(small);
    expect(facts.footprint.quality?.unreadable.find((u) => u.expressId === small)?.reason).toMatch(/less than 1 m²/);
  });
});

describe('finding 3: one prepared footprint for every query', () => {
  it('a stair descending in a 0.2 m gap between two room slabs is interior, like every other query says', async () => {
    const facts = await extract(roomSlabs((b) => {
      const body = b.shape([b.rectExtrusion(0, 0, 0.15, 1, 2, b.axis(0, 0, -2), b.dir(0, 0, 1))]);
      b.contain(b.storeys.eg.id, b.add(`IFCSTAIR(${b.guid()},$,'Treppe Fuge',$,$,#${b.place(b.storeys.eg.pl, 10, 5, 0)},#${body},$,.STRAIGHT_RUN_STAIR.)`));
    }), false);
    expect(facts.candidates.map((c) => c.name)).not.toContain('Treppe Fuge');
    expect(facts.skipped.find((s) => s.ifcClass === 'IfcStair')?.reason).toMatch(/interior stair/);
  });

  it('geom.ts exports no footprint query on raw rings', () => {
    expect(Object.keys(geom).sort()).toEqual(['bboxOf', 'chainIntoRing', 'closestBoundaryPoint', 'convexHull', 'expandBBox', 'insideRing', 'ringArea', 'ringContainsRing', 'segmentsIntersect']);
  });

  /** Every point of a grid over the footprint (plus a line across each gap): the queries agree with each other. */
  function sweep(fp: PreparedFootprint, extraPoints: MapPoint[] = []): number {
    const xs = fp.rings.flat().map((p) => p.x);
    const ys = fp.rings.flat().map((p) => p.y);
    const pts: MapPoint[] = [...extraPoints];
    for (let x = Math.min(...xs) - 3; x <= Math.max(...xs) + 3; x += 0.5) for (let y = Math.min(...ys) - 3; y <= Math.max(...ys) + 3; y += 0.5) pts.push({ x, y });
    let inside = 0;
    for (const p of pts) {
      const d = signedDistance(fp, p)!; // non-empty fixtures: always known
      const isIn = insideFootprint(fp, p);
      // On the boundary itself the distance is 0 whichever way the inside test rounds; everywhere else its sign is the test.
      if (Math.abs(d) > 1e-9) expect(d < 0, `${p.x - E0},${p.y - N0}`).toBe(isIn);
      expect(outsideBy(fp, p, 1)).toBe(d >= 1);
      if (isIn) {
        inside++;
        expect(closestOutlinePoint(fp, p)!.distance).toBeCloseTo(-d, 9);
      }
    }
    return inside;
  }
  const across = (x0: number, x1: number, y: number) => Array.from({ length: 11 }, (_, k) => P(x0 + ((x1 - x0) * k) / 10, y));

  it('repro F (slab rings 0.2 m apart): the gap is inside for every query', () => {
    const fp = prepareFootprint({ rings: [rect(0, 0, 10, 10), rect(10.2, 0, 20, 10)], source: 'slab-outline' });
    expect(sweep(fp, across(9.9, 10.3, 1.5))).toBeGreaterThan(0);
    expect(insideFootprint(fp, P(10.1, 1.5))).toBe(true);
    // An independent oracle (CodeRabbit): beside the seam the real outline is the south and north façades, 5 m away, not the seam.
    expect(signedDistance(fp, P(9.5, 5))).toBeCloseTo(-5, 6);
    // In the gap the nearest outline is a slab corner beside the gap's mouth (no ring edge spans it): 5.001 m.
    expect(signedDistance(fp, P(10.1, 5))).toBeCloseTo(-Math.hypot(0.1, 5), 6);
  });

  it('repro G (extracted room slabs): the gap is inside for every query', async () => {
    const facts = await extract(roomSlabs(), false);
    const fp = prepareFootprint(facts.footprint);
    sweep(fp);
    expect(insideFootprint(fp, mapOf(10, 5))).toBe(true);
  });

  it('repro C1 (a given courtyard behind a seam): the courtyard is outside, the seam inside, for every query', () => {
    const fp = prepareFootprint({ rings: [rect(0, 0, 10, 12), rect(10, 0, 20, 12), rect(10.15, 1, 14, 6)], source: 'given' });
    sweep(fp, across(9.8, 10.5, 1.5));
    expect(insideFootprint(fp, P(12, 3))).toBe(false);
    expect(insideFootprint(fp, P(10, 1.5))).toBe(true);
  });

  it('the courtyard-ramp case (a given footprint with a courtyard ring): the courtyard is outside for every query', () => {
    const fp = prepareFootprint({ rings: [local([[0, 0], [20, 0], [20, 10], [0, 10]]), local([[6, 2], [14, 2], [14, 8], [6, 8]])], source: 'given' });
    sweep(fp);
    expect(insideFootprint(fp, mapOf(10, 5))).toBe(false);
  });
});

describe('finding 4: a given footprint needs one ring of 1 m², not every ring', () => {
  it('a 20 x 10 m outline with a 0.5 x 0.5 m inner ring is accepted; the small ring is below the closing scale, closed, with a note', async () => {
    const store = await parseStep(syntheticHouse({ verticalDatum: 'LN02' }));
    const facts = extractModelFacts(store, {
      expectedCrs: 'EPSG:2056',
      groundStorey: 'EG',
      footprint: [local([[0, 0], [20, 0], [20, 10], [0, 10]]), local([[9, 4], [9.5, 4], [9.5, 4.5], [9, 4.5]])],
    });
    expect(facts.footprint.quality?.conditions).not.toContain('courtyard-ring');
    expect(facts.footprint.quality?.notes.join()).toMatch(/below the closing scale/);
    expect(insideFootprint(prepareFootprint(facts.footprint), mapOf(9.25, 4.25))).toBe(true);
  });

  it('control: a given footprint whose rings all enclose less than 1 m² is still refused', async () => {
    const store = await parseStep(syntheticHouse({ verticalDatum: 'LN02' }));
    expect(() => extractModelFacts(store, { expectedCrs: 'EPSG:2056', footprint: [local([[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]])] })).toThrow(RangeError);
  });
});
