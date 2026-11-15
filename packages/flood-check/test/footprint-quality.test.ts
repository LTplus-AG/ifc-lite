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
import { footprintConcerns, type FootprintQuality } from '../src/model/facts.js';
import { footprintDoubt, groundDoubt, scopeExclusion, type CandidateContext } from '../src/model/candidate-base.js';
import { mapOf } from './synthetic-model.js';
import { CELL_NO_RUNOFF, type MapPoint } from '../src/types.js';
import { CODE, CONFIRMED, flatTerrain } from './helpers.js';
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
  return extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', slab: false, extra })), { expectedCrs: 'EPSG:2056', ...given });
}

/** The expected worst quality of a chain. */
function expected(slabs: Slabs, w: Walls): FootprintQuality {
  if (slabs === 'given' || slabs === 'slab readable') return 'complete';
  if (slabs === 'slab with voids') return 'voids-filled';
  if (slabs === 'slab partly readable') return 'partial';
  if (w !== 'walls full loop') return 'hull';
  return slabs === 'slab unreadable' ? 'partial' : 'complete';
}

describe('footprint source chains', () => {
  const rows: Array<[Slabs, Walls]> = [];
  for (const slabs of ['given', 'slab readable', 'slab with voids', 'slab partly readable', 'slab unreadable', 'no slab'] as const) {
    for (const w of ['walls full loop', 'walls partial loop', 'no walls'] as const) rows.push([slabs, w]);
  }

  it.each(rows)('%s, %s', async (slabs, w) => {
    const facts = await chain(slabs, w);
    const worst = footprintConcerns(facts.footprint).worst;
    expect(worst).toBe(expected(slabs, w));
    expect(facts.footprint.quality?.worst).toBe(worst);
    // A chain with an unreadable or partly readable source never ends complete, and keeps the list of what could not be read.
    if (slabs === 'slab partly readable' || slabs === 'slab unreadable') {
      expect(worst).not.toBe('complete');
      expect(facts.footprint.quality?.unreadable.map((u) => u.ifcClass)).toContain('IfcSlab');
      expect(facts.footprint.partial).toBe(true);
    }
  });

  it('the quality record cannot be changed after the fact', async () => {
    const q = (await chain('slab unreadable', 'walls full loop')).footprint.quality!;
    expect(Object.isFrozen(q) && Object.isFrozen(q.conditions) && Object.isFrozen(q.unreadable)).toBe(true);
  });

  it('end to end: no element gets a reassuring outcome on a footprint that is voids-filled, partial or a hull', async () => {
    const paints: Array<(l: MapPoint) => number> = [() => CELL_NO_RUNOFF, () => CODE['depth-0-0.1'], bandRound40];
    let checked = 0;
    for (const [slabs, w] of rows) {
      const facts = await chain(slabs, w);
      const worst = footprintConcerns(facts.footprint).worst;
      if (worst === 'complete' || worst === 'courtyard-ring') continue;
      for (const paint of paints) {
        const r = checkFloodExposure(facts, raster(paint), flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
        for (const x of r.results) {
          checked++;
          expect(['above-mapped-class-range', 'no-runoff-mapped'], `${slabs}, ${w}: ${x.candidate.name}`).not.toContain(x.outcome);
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe('decisions that rest on an uncertain ground storey or footprint keep the element', () => {
  const ctx = (over: Partial<CandidateContext>) => ({
    storeyOf: () => 2,
    storeyLevel: new Map([[2, 504]]),
    groundLevel: 500,
    aboveGroundScope: 3,
    ...over,
  }) as unknown as CandidateContext;

  it('out of scope only when the ground storey is known', () => {
    expect(scopeExclusion(ctx({}), 1, 505, false)).toMatch(/out of scope/);
    expect(scopeExclusion(ctx({ groundUncertain: true }), 1, 505, false)).toBeNull();
    expect(groundDoubt(ctx({ groundUncertain: true }))).toMatch(/guessed/);
  });

  it('inside a hull or a voids-filled footprint proves nothing; outside a partial one neither', () => {
    expect(footprintDoubt(ctx({ footprintQuality: { hullLike: true, partial: false } }), -5)).toMatch(/fills courtyards/);
    expect(footprintDoubt(ctx({ footprintQuality: { hullLike: false, partial: true } }), 5)).toMatch(/partial/);
    expect(footprintDoubt(ctx({ footprintQuality: { hullLike: false, partial: true } }), -5)).toBeNull();
    expect(footprintDoubt(ctx({ footprintQuality: { hullLike: false, partial: false } }), -5)).toBeNull();
  });

  it('a door with no IsExternal on a voids-filled slab, far from its outer outline (a courtyard façade), is kept', async () => {
    const facts = extractModelFacts(await parseStep(syntheticHouse({
      verticalDatum: 'LN02',
      slab: false,
      extra: (b) => {
        slab(b, true, 0, true);
        b.contain(b.storeys.eg.id, b.add(`IFCDOOR(${b.guid()},$,'Hoftür',$,$,#${b.place(b.storeys.eg.pl, 10, 3, 0)},$,$,2.1,1.,.DOOR.,$,$)`));
      },
    })), { expectedCrs: 'EPSG:2056' });
    expect(footprintConcerns(facts.footprint).worst).toBe('voids-filled');
    expect(facts.candidates.find((c) => c.name === 'Hoftür')?.selectedBecause).toMatch(/fills courtyards/);
  });
});
