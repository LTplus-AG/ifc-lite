/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A file with two buildings (review finding "absence-reads-as-success"): the
 * footprint is the ground storey's building, so an element of the other
 * building was sampled next to itself, inside its own building where the map
 * shows no depth, and read as "no runoff mapped" even with a deep class all
 * round that building. Only the ground storey's building is checked; the other
 * is named with its count.
 */

import { describe, expect, it } from 'vitest';
import { checkFloodExposure } from '../src/check/check.js';
import { FloodCheckRefusal } from '../src/errors.js';
import { toPropertySets } from '../src/psets.js';
import { BAFU_CLASSES } from '../src/bafu/dataset.js';
import { extractModelFacts } from '../src/model/extract.js';
import { CELL_NO_RUNOFF, type MapPoint } from '../src/types.js';
import { CODE, CONFIRMED, flatTerrain, syntheticRaster } from './helpers.js';
import { mapOf, ORIGIN, parseStep, ROTATION_DEG, syntheticHouse, type Extra } from './synthetic-model.js';

function localOf(p: MapPoint): { x: number; y: number } {
  const a = (ROTATION_DEG * Math.PI) / 180;
  const dx = p.x - ORIGIN.e;
  const dy = p.y - ORIGIN.n;
  return { x: dx * Math.cos(a) + dy * Math.sin(a), y: -dx * Math.sin(a) + dy * Math.cos(a) };
}

/** A second building, 20 m x 10 m, `gap` metres east of the house, with a door, a basement window and a boiler. */
function secondBuilding(gap: number) {
  return (b: Extra) => {
    const x0 = 20 + gap;
    const pl = b.place(b.site.pl, x0, 0, 0);
    const bld = b.add(`IFCBUILDING(${b.guid()},$,'Nebengebäude',$,$,#${pl},$,$,.ELEMENT.,$,$,$)`);
    b.add(`IFCRELAGGREGATES(${b.guid()},$,$,$,#${b.site.id},(#${bld}))`);
    const ugPl = b.place(pl, 0, 0, -3);
    const ug = b.add(`IFCBUILDINGSTOREY(${b.guid()},$,'B UG',$,$,#${ugPl},$,$,.ELEMENT.,-3.)`);
    const egPl = b.place(pl, 0, 0, 0);
    const eg = b.add(`IFCBUILDINGSTOREY(${b.guid()},$,'B EG',$,$,#${egPl},$,$,.ELEMENT.,0.)`);
    b.add(`IFCRELAGGREGATES(${b.guid()},$,$,$,#${bld},(#${ug},#${eg}))`);
    const slabSolid = b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
    const slab = b.add(`IFCSLAB(${b.guid()},$,'B Bodenplatte',$,$,#${b.place(egPl, 0, 0, 0)},#${b.shape([slabSolid])},$,.FLOOR.)`);
    const door = b.add(`IFCDOOR(${b.guid()},$,'B Tür',$,$,#${b.place(egPl, 10, 0, 0)},#${b.shape([b.rectExtrusion(0, 0, 1, 0.1, 2.1, b.axis(0, 0, 0), b.dir(0, 0, 1))])},$,2.1,1.,.DOOR.,$,$)`);
    b.pset(door, 'Pset_DoorCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
    const plain = b.add(`IFCDOOR(${b.guid()},$,'B Tür ohne Pset',$,$,#${b.place(egPl, 15, 0, 0)},#${b.shape([b.rectExtrusion(0, 0, 1, 0.1, 2.1, b.axis(0, 0, 0), b.dir(0, 0, 1))])},$,2.1,1.,.DOOR.,$,$)`);
    const win = b.add(`IFCWINDOW(${b.guid()},$,'B Kellerfenster',$,$,#${b.place(ugPl, 5, 0, 2)},#${b.shape([b.rectExtrusion(0, 0, 0.8, 0.1, 0.5, b.axis(0, 0, 0), b.dir(0, 0, 1))])},$,0.5,0.8,.WINDOW.,$,$)`);
    b.pset(win, 'Pset_WindowCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
    const boiler = b.add(`IFCBOILER(${b.guid()},$,'B Heizkessel',$,$,#${b.place(ugPl, 10, 5, 0)},$,$,.WATER.)`);
    b.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${b.guid()},$,$,$,(#${door},#${plain},#${slab}),#${eg})`);
    b.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${b.guid()},$,$,$,(#${win},#${boiler}),#${ug})`);
  };
}

const deep = CODE['depth-gt-0.25'];
/** A 4 m band around a local box, raised building inside transparent. */
const bandAround = (x0: number, x1: number) => (p: MapPoint) => {
  const l = localOf(p);
  const inside = l.x >= x0 && l.x <= x1 && l.y >= 0 && l.y <= 10;
  const near = l.x >= x0 - 4 && l.x <= x1 + 4 && l.y >= -4 && l.y <= 14;
  return near && !inside ? deep : CELL_NO_RUNOFF;
};

async function twoBuildings(gap: number, groundStorey?: string) {
  const store = await parseStep(syntheticHouse({ verticalDatum: 'LN02', extra: secondBuilding(gap) }));
  return extractModelFacts(store, { expectedCrs: 'EPSG:2056', ...(groundStorey ? { groundStorey } : {}) });
}

function rasterOver(gap: number, paint: (p: MapPoint) => number) {
  const corners = [mapOf(-10, -10), mapOf(50 + gap, -10), mapOf(-10, 20), mapOf(50 + gap, 20)];
  const x0 = Math.floor(Math.min(...corners.map((p) => p.x)));
  const y0 = Math.floor(Math.min(...corners.map((p) => p.y)));
  const x1 = Math.ceil(Math.max(...corners.map((p) => p.x)));
  const y1 = Math.ceil(Math.max(...corners.map((p) => p.y)));
  return syntheticRaster(x0, y0, (x1 - x0) * 2, (y1 - y0) * 2, 0.5, paint);
}

const B_ELEMENTS = ['B Tür', 'B Kellerfenster', 'B Heizkessel'];

describe('a file with two buildings', () => {
  for (const gap of [20, 100]) {
    describe(`the second building ${gap} m away`, () => {
      // Since audit finding 4 the second building's door without IsExternal (on its own façade, far outside the checked
      // footprint) cannot be interior, so it is kept and counted among the elements not checked: 4, where it was 3.
      it('checks only the ground storey\'s building and names the other with its count', async () => {
        const facts = await twoBuildings(gap);
        const names = facts.candidates.map((c) => c.name);
        for (const n of B_ELEMENTS) expect(names).not.toContain(n);
        expect(names).toContain('Heizkessel');
        expect(facts.buildingScope).toMatchObject({
          checked: { name: 'House' },
          notChecked: [{ name: 'Nebengebäude', candidatesNotChecked: 4 }],
        });
        expect(facts.skipped.filter((s) => /which was not checked/.test(s.reason))).toHaveLength(4);
        expect(facts.warnings.join()).toMatch(/only "House" .* was checked\. Not checked: "Nebengebäude" .*\(4 candidate element\(s\)\)/);
      });

      for (const [scenario, paint] of [
        ['nothing mapped anywhere', () => CELL_NO_RUNOFF],
        ['a deep class all round the second building', bandAround(20 + gap, 40 + gap)],
        ['a deep class all round the checked building', bandAround(0, 20)],
      ] as const) {
        it(`${scenario}: no element of the second building gets a result, and the result says so`, async () => {
          const facts = await twoBuildings(gap);
          const r = checkFloodExposure(facts, rasterOver(gap, paint), flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
          expect(r.results.map((x) => x.candidate.name)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^B /)]));
          expect(r.buildingScope.notChecked).toMatchObject([{ name: 'Nebengebäude', candidatesNotChecked: 4 }]);
          expect(r.warnings.join()).toMatch(/Not checked: "Nebengebäude"/);
          const site = Object.fromEntries(toPropertySets(r, BAFU_CLASSES).site.Properties.map((p) => [p.Name, p.NominalValue]));
          expect(site).toMatchObject({ CheckedBuilding: expect.stringMatching(/^"House"/), CountElementsNotChecked: 4 });
          expect(site.BuildingsNotChecked).toMatch(/^"Nebengebäude" .*: 4$/);
        });
      }

      it('the second building checked on its own: its boiler deep inside it is not "no runoff mapped", its door is exposed', async () => {
        const facts = await twoBuildings(gap, 'B EG');
        expect(facts.buildingScope).toMatchObject({ checked: { name: 'Nebengebäude' }, notChecked: [{ name: 'House' }] });
        const r = checkFloodExposure(facts, rasterOver(gap, bandAround(20 + gap, 40 + gap)), flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
        expect(facts.footprint.source).toBe('slab-outline');
        const by = Object.fromEntries(r.results.map((x) => [x.candidate.name, x]));
        expect(Object.keys(by).sort()).toEqual(['B Heizkessel', 'B Kellerfenster', 'B Tür', 'B Tür ohne Pset']);
        expect(by['B Tür'].outcome).toBe('exposed');
        expect(by['B Kellerfenster'].outcome).toBe('exposed');
        expect(by['B Heizkessel'].outcome).toBe('exposed');
        expect(by['B Heizkessel'].anchorBasis).toBe('nearest-outline-point');
      });
    });
  }

  it('the checked building\'s own results do not change with the second building', async () => {
    const alone = extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02' })), { expectedCrs: 'EPSG:2056' });
    const both = await twoBuildings(20);
    for (const paint of [() => CELL_NO_RUNOFF, bandAround(0, 20), bandAround(40, 60)]) {
      const run = (f: typeof alone) =>
        checkFloodExposure(f, rasterOver(20, paint), flatTerrain(499.95), { renderingConfirmation: CONFIRMED }).results.map((x) => [x.candidate.name, x.outcome]);
      expect(run(both)).toEqual(run(alone));
    }
  });

  it('refuses when there are several buildings and the ground storey is in none of them', async () => {
    const text = syntheticHouse({
      verticalDatum: 'LN02',
      extra: (b) => {
        const pl = b.place(b.site.pl, 60, 0, 0);
        const bld = b.add(`IFCBUILDING(${b.guid()},$,'Leer',$,$,#${pl},$,$,.ELEMENT.,$,$,$)`);
        b.add(`IFCRELAGGREGATES(${b.guid()},$,$,$,#${b.site.id},(#${bld}))`);
        const orphanPl = b.place(b.site.pl, 0, 0, -10);
        b.add(`IFCBUILDINGSTOREY(${b.guid()},$,'Lose',$,$,#${orphanPl},$,$,.ELEMENT.,-10.)`);
      },
    });
    const store = await parseStep(text);
    expect(() => extractModelFacts(store, { expectedCrs: 'EPSG:2056', groundStorey: 'Lose' })).toThrow(FloodCheckRefusal);
    try {
      extractModelFacts(store, { expectedCrs: 'EPSG:2056', groundStorey: 'Lose' });
    } catch (e) {
      expect((e as FloodCheckRefusal).code).toBe('ambiguous-building');
    }
    // The default ground storey is the house's, so it is checked with the empty building named.
    expect(extractModelFacts(store, { expectedCrs: 'EPSG:2056' }).buildingScope).toMatchObject({
      checked: { name: 'House' },
      notChecked: [{ name: 'Leer', candidatesNotChecked: 0 }],
    });
  });
});
