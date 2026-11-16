/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Footprint quality is one record that only accumulates through the chain of
 * footprint sources (`footprint.ts`): a fallback may supply geometry, never
 * upgrade the quality or drop what could not be read.
 */

import { describe, expect, it } from 'vitest';
import { checkFloodExposure } from '../src/check/check.js';
import { extractModelFacts } from '../src/model/extract.js';
import { footprintConcerns } from '../src/model/facts.js';
import { mapOf } from './synthetic-model.js';
import { CELL_NO_RUNOFF, type MapPoint } from '../src/types.js';
import { CODE, CONFIRMED, flatTerrain, NO_OTHER_BUILDINGS } from './helpers.js';
import { localOf, raster } from './candidate-fixtures.js';
import { parseStep, syntheticHouse, type Extra } from './synthetic-model.js';

const deep = CODE['depth-gt-0.25'];

/** External walls with axes along a chain of local points (one wall per segment), in the ground storey. */
function wallLoop(b: Extra, pts: Array<[number, number]>) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const axis = b.add(`IFCPOLYLINE((#${b.pt2(ax, ay)},#${b.pt2(bx, by)}))`);
    const wall = b.add(`IFCWALL(${b.guid()},$,'Wand ${i}',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([axis], 'Axis', 'Curve2D')},$,.STANDARD.)`);
    b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
    b.contain(b.storeys.eg.id, wall);
  }
}

/** The reviewer's case: the only ground slab (0..40 m) is an unreadable Brep; external walls loop round the 0..20 m main wing only. */
function unreadableSlabPartialWallLoop(b: Extra) {
  const slab = b.add(`IFCSLAB(${b.guid()},$,'Bodenplatte Brep',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`)], 'Body', 'Brep')},$,.FLOOR.)`);
  b.contain(b.storeys.eg.id, slab);
  wallLoop(b, [[20, 0], [20, 10], [0, 10], [0, 0]]); // with the house's own south wall 0..20 at y = 0: a closed loop
  b.contain(b.storeys.ug.id, b.add(`IFCBOILER(${b.guid()},$,'Kessel Anbau',$,$,#${b.place(b.storeys.ug.pl, 30, 5, 0)},$,$,.WATER.)`));
}

/** A deep class in a 4 m band round the real 40 m x 10 m building, which itself is raised (transparent). */
const bandRound40 = (l: MapPoint) => {
  const inside = l.x >= 0 && l.x <= 40 && l.y >= 0 && l.y <= 10;
  return !inside && l.x > -4 && l.x < 44 && l.y > -4 && l.y < 14 ? deep : CELL_NO_RUNOFF;
};

describe('the reported case', () => {
  it('an unreadable slab stays recorded through the wall-loop fallback, so the annex boiler is not "no runoff mapped"', async () => {
    const facts = extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', slab: false, extra: unreadableSlabPartialWallLoop })), { expectedCrs: 'EPSG:2056' });
    expect(facts.footprint.source).toBe('external-wall-outline');
    expect(facts.footprint.partial).toBe(true);
    const r = checkFloodExposure(facts, raster(bandRound40), flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
    const boiler = r.results.find((x) => x.candidate.name === 'Kessel Anbau')!;
    expect(localOf(boiler.candidate.position).x).toBeCloseTo(30, 1);
    expect(boiler.outcome).not.toBe('no-runoff-mapped');
    expect(boiler).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'partial-footprint' });
  });
});

type Slabs = 'given' | 'slab readable' | 'slab with voids' | 'slab partly readable' | 'slab unreadable' | 'no slab';
type Walls = 'walls full loop' | 'walls partial loop' | 'no walls';

/** A ground-storey slab over local 0..20 x 0..10, readable (an extrusion) or not (a Brep). */
function slab(b: Extra, readable: boolean, x0 = 0, voids = false) {
  let body: number;
  if (readable && !voids) {
    body = b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
  } else if (readable) {
    const outer = b.add(`IFCPOLYLINE((#${b.pt2(0, 0)},#${b.pt2(20, 0)},#${b.pt2(20, 10)},#${b.pt2(0, 10)},#${b.pt2(0, 0)}))`);
    const inner = b.add(`IFCPOLYLINE((#${b.pt2(8, 3)},#${b.pt2(12, 3)},#${b.pt2(12, 7)},#${b.pt2(8, 7)},#${b.pt2(8, 3)}))`);
    const profile = b.add(`IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#${outer},(#${inner}))`);
    body = b.add(`IFCEXTRUDEDAREASOLID(#${profile},#${b.axis(0, 0, 0)},#${b.dir(0, 0, -1)},0.3)`);
  } else {
    body = b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`);
  }
  const s = b.add(`IFCSLAB(${b.guid()},$,'Platte',$,$,#${b.place(b.storeys.eg.pl, x0, 0, 0)},#${b.shape([body])},$,.FLOOR.)`);
  b.contain(b.storeys.eg.id, s);
}

/** The house's own south wall (0..20 at y = 0) is always there; a full loop adds east, north and west, a partial loop leaves out the west. */
function walls(b: Extra, w: Walls) {
  if (w === 'walls full loop') wallLoop(b, [[20, 0], [20, 10], [0, 10], [0, 0]]);
  if (w === 'walls partial loop') wallLoop(b, [[20, 0], [20, 10], [0, 10]]);
}

async function chain(slabs: Slabs, w: Walls) {
  const extra = (b: Extra) => {
    if (slabs === 'slab readable') slab(b, true);
    if (slabs === 'slab with voids') slab(b, true, 0, true);
    if (slabs === 'slab partly readable') { slab(b, true); slab(b, false, 20); }
    if (slabs === 'slab unreadable') slab(b, false);
    walls(b, w);
  };
  const given = slabs === 'given' ? { footprint: [[mapOf(0, 0), mapOf(20, 0), mapOf(20, 10), mapOf(0, 10)]] } : {};
  // The ground storey is stated: otherwise the height reference alone would withhold every favourable outcome (item 21).
  return extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', slab: false, extra })), { expectedCrs: 'EPSG:2056', groundStorey: 'EG', ...given });
}

describe('footprint source chains', () => {
  const rows: Array<[Slabs, Walls]> = [];
  for (const slabs of ['given', 'slab readable', 'slab with voids', 'slab partly readable', 'slab unreadable', 'no slab'] as const) {
    for (const w of ['walls full loop', 'walls partial loop', 'no walls'] as const) rows.push([slabs, w]);
  }

  it('end to end: no element gets a reassuring outcome on a footprint that is voids-filled, partial or a hull', async () => {
    const paints: Array<(l: MapPoint) => number> = [() => CELL_NO_RUNOFF, () => CODE['depth-0-0.1'], bandRound40];
    // A stated ground storey and a complete other-buildings source, so only the footprint can withhold; the control proves a
    // complete footprint does reach a favourable outcome under the same conditions (the test can fail).
    const opts = { renderingConfirmation: CONFIRMED, otherBuildings: NO_OTHER_BUILDINGS };
    let checked = 0;
    let withheld = 0;
    let controlFavourable = 0;
    const expectedWorst: Record<string, string> = {
      'given|walls full loop': 'complete', 'given|walls partial loop': 'complete', 'given|no walls': 'complete',
      'slab readable|walls full loop': 'complete', 'slab readable|walls partial loop': 'complete', 'slab readable|no walls': 'complete',
      'slab with voids|walls full loop': 'courtyard-ring', 'slab with voids|walls partial loop': 'courtyard-ring', 'slab with voids|no walls': 'courtyard-ring',
      'slab partly readable|walls full loop': 'partial', 'slab partly readable|walls partial loop': 'partial', 'slab partly readable|no walls': 'partial',
      'slab unreadable|walls full loop': 'partial', 'slab unreadable|walls partial loop': 'hull', 'slab unreadable|no walls': 'hull',
      'no slab|walls full loop': 'complete', 'no slab|walls partial loop': 'hull', 'no slab|no walls': 'hull',
    };
    for (const [slabs, w] of rows) {
      const facts = await chain(slabs, w);
      const worst = footprintConcerns(facts.footprint).worst;
      expect(worst, `${slabs}, ${w}: footprint quality`).toBe(expectedWorst[`${slabs}|${w}`]);
      if (worst === 'complete') {
        for (const paint of paints) {
          const r = checkFloodExposure(facts, raster(paint), flatTerrain(499.95), opts);
          controlFavourable += r.results.filter((x) => ['above-mapped-class-range', 'no-runoff-mapped'].includes(x.outcome)).length;
        }
        continue;
      }
      if (worst === 'courtyard-ring') continue;
      for (const paint of paints) {
        const r = checkFloodExposure(facts, raster(paint), flatTerrain(499.95), opts);
        for (const x of r.results) {
          checked++;
          expect(['above-mapped-class-range', 'no-runoff-mapped'], `${slabs}, ${w}: ${x.candidate.name}`).not.toContain(x.outcome);
          // Such a footprint also keeps the doors from confirming the height reference, so the outcome alone cannot show the
          // footprint guard at work: wherever a favourable outcome is withheld, the footprint must be among the reasons.
          if (x.favourableWithheldBecause.length > 0) {
            withheld++;
            expect(x.favourableWithheldBecause.join(' '), `${slabs}, ${w}: ${x.candidate.name}`).toMatch(/footprint/);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(withheld).toBeGreaterThan(10);
    expect(controlFavourable).toBeGreaterThan(0);
  });

});

