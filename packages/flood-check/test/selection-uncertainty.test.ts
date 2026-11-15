/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review round on head 4fa60bd3: an element must not be excluded, or cleared,
 * on data that is known to be incomplete or stale.
 */

import { describe, expect, it } from 'vitest';
import { checkFloodExposure } from '../src/check/check.js';
import { extractModelFacts } from '../src/model/extract.js';
import { CELL_NO_RUNOFF, type MapPoint } from '../src/types.js';
import { boxFacts, candidate, CODE, CONFIRMED, E0, flatTerrain, N0, syntheticRaster } from './helpers.js';
import { parseStep, syntheticHouse, type Extra } from './synthetic-model.js';

const deep = CODE['depth-gt-0.25'];
const sq = (x0: number, y0: number, x1: number, y1: number): MapPoint[] => [
  { x: E0 + x0, y: N0 + y0 }, { x: E0 + x1, y: N0 + y0 }, { x: E0 + x1, y: N0 + y1 }, { x: E0 + x0, y: N0 + y1 },
];
const inBox = (p: MapPoint, x0: number, y0: number, x1: number, y1: number) => p.x > E0 + x0 && p.x < E0 + x1 && p.y > N0 + y0 && p.y < N0 + y1;
const extract = async (extra: (b: Extra) => void) =>
  extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', extra })), { expectedCrs: 'EPSG:2056' });

describe('the courtyard guard', () => {
  it('follows rings appended to the same footprint array between checks (no stale cache)', () => {
    const rings = [sq(0, 0, 30, 30)];
    const door = candidate({ name: 'Hoftür', position: { x: E0 + 15, y: N0 + 2 }, level: 500 });
    const facts = boxFacts([door], { footprint: { rings, source: 'given', fromElements: [] } });
    const raster = syntheticRaster(E0 - 10, N0 - 10, 100, 100, 0.5, (p) => (inBox(p, 2, 2, 28, 28) ? deep : CELL_NO_RUNOFF));
    checkFloodExposure(facts, raster, flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
    rings.push(sq(2, 2, 28, 28)); // the courtyard, added in place
    const r = checkFloodExposure(facts, raster, flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
    expect(r.results[0]).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'courtyard-ring' });
  });

  it('recognises a courtyard ring that two overlapping rings cover only together', () => {
    // A = 0..6 x 0..10 and B = 4..10 x 0..10 overlap; the courtyard C = 2..8 x 1..9 lies in neither alone.
    const rings = [sq(0, 0, 6, 10), sq(4, 0, 10, 10), sq(2, 1, 8, 9)];
    const door = candidate({ name: 'Hoftür', position: { x: E0 + 5, y: N0 + 1 }, level: 500 });
    const facts = boxFacts([door], { footprint: { rings, source: 'given', fromElements: [] } });
    const raster = syntheticRaster(E0 - 10, N0 - 10, 60, 60, 0.5, (p) => (inBox(p, 2, 1, 8, 9) ? deep : CELL_NO_RUNOFF));
    const r = checkFloodExposure(facts, raster, flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
    expect(r.results[0]).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'courtyard-ring' });
  });
});

describe('an upper-estimate level does not exclude', () => {
  /** A window whose filled opening reads only from 504 m up, beside an unreadable Brep that may reach lower. */
  /** `overallHeight` as written into the STEP record: '$' (none stated) leaves the level unbounded. */
  const window = (storey: 'eg' | 'og', overallHeight = '$') => (b: Extra) => {
    const wall = b.add(`IFCWALL(${b.guid()},$,'Wand Ost',$,$,#${b.place(b.storeys.eg.pl, 20, 0, 0)},$,$,.STANDARD.)`);
    b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
    const upper = b.rectExtrusion(0, 0, 1, 1, 0.4, b.axis(-0.2, 5, 4.5, b.dir(1, 0, 0), b.dir(0, 1, 0)), b.dir(0, 0, 1));
    const brep = b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`);
    const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung hoch',$,$,#${b.place(b.storeys.eg.pl, 20, 0, 0)},#${b.shape([upper, brep])},$,.OPENING.)`);
    b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
    const win = b.add(`IFCWINDOW(${b.guid()},$,'Fenster hoch',$,$,#${b.place(b.storeys.eg.pl, 20, 5, 4.5)},$,$,${overallHeight},1.,.WINDOW.,$,$)`);
    b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${win})`);
    b.contain(b.storeys.eg.id, wall);
    b.contain(b.storeys[storey].id, win);
  };

  it('a ground-storey window whose only readable hole part is above the scope is kept, as an upper estimate', async () => {
    const facts = await extract(window('eg'));
    expect(facts.candidates.find((c) => c.name === 'Fenster hoch')).toMatchObject({ levelIsUpperEstimate: true });
  });

  it('control: the same window stating a 1 m OverallHeight is proven out of scope (it cannot reach below 503.5 m)', async () => {
    const facts = await extract(window('og', '1.'));
    expect(facts.candidates.map((c) => c.name)).not.toContain('Fenster hoch');
    expect(facts.skipped.find((s) => s.ifcClass === 'IfcWindow' && /out of scope/.test(s.reason))).toBeDefined();
  });
});

describe('a flight its stair does not assess', () => {
  it('an external flight outside the footprint keeps its own result when its stair is skipped as interior', async () => {
    const facts = await extract((b) => {
      const flight = b.add(`IFCSTAIRFLIGHT(${b.guid()},$,'Lauf aussen',$,$,#${b.place(b.storeys.eg.pl, 25, -3, 0)},$,$,$,$,$,$,.STRAIGHT.)`);
      b.pset(flight, 'Pset_StairFlightCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
      const stair = b.add(`IFCSTAIR(${b.guid()},$,'Treppe innen',$,$,#${b.place(b.storeys.eg.pl, 10, 5, 0)},$,$,.STRAIGHT_RUN_STAIR.)`);
      b.add(`IFCRELAGGREGATES(${b.guid()},$,$,$,#${stair},(#${flight}))`);
      b.contain(b.storeys.eg.id, stair);
    });
    expect(facts.skipped.find((s) => s.ifcClass === 'IfcStair' && /interior stair/.test(s.reason))).toBeDefined();
    expect(facts.candidates.map((c) => c.name)).toContain('Lauf aussen');
  });
});

describe('a partial footprint does not exclude façade elements', () => {
  it('a window in the area the footprint misses, with no IsExternal, is kept', async () => {
    const facts = await extract((b) => {
      const slab = b.add(`IFCSLAB(${b.guid()},$,'Bodenplatte Anbau',$,$,#${b.place(b.storeys.eg.pl, 20, 0, 0)},#${b.shape([b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`)], 'Body', 'Brep')},$,.FLOOR.)`);
      b.contain(b.storeys.eg.id, slab);
      b.contain(b.storeys.eg.id, b.add(`IFCWINDOW(${b.guid()},$,'Fenster Anbau',$,$,#${b.place(b.storeys.eg.pl, 40, 5, 1)},$,$,1.,1.,.WINDOW.,$,$)`));
      // Control: an interior door inside the readable part stays interior.
      b.contain(b.storeys.eg.id, b.add(`IFCDOOR(${b.guid()},$,'Innentür',$,$,#${b.place(b.storeys.eg.pl, 10, 5, 0)},$,$,2.1,1.,.DOOR.,$,$)`));
    });
    expect(facts.footprint.partial).toBe(true);
    expect(facts.candidates.find((c) => c.name === 'Fenster Anbau')?.selectedBecause).toMatch(/footprint is partial/);
    expect(facts.candidates.map((c) => c.name)).not.toContain('Innentür');
  });
});
