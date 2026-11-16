/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Elements that were dropped, or a footprint that silently covered only part
 * of the building (review round on the model extraction).
 */

import { describe, expect, it } from 'vitest';
import { FloodCheckRefusal } from '../src/errors.js';
import { extractModelFacts } from '../src/model/extract.js';
import { parseStep, syntheticHouse, type Extra } from './synthetic-model.js';

const extract = async (extra: (b: Extra) => void) =>
  extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', extra })), { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });

describe('a window placed at its head above the scope, whose opening reaches down to the sill', () => {
  it('is listed at the bottom of its opening', async () => {
    const facts = await extract((b) => {
      const wall = b.add(`IFCWALL(${b.guid()},$,'Wand Ost',$,$,#${b.place(b.storeys.eg.pl, 20, 0, 0)},$,$,.STANDARD.)`);
      b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
      // Hole 1 m wide, z 0.5..3.5 (local), extruded through the wall.
      const solid = b.rectExtrusion(0, 0, 1, 3, 0.4, b.axis(0, 5, 2, b.dir(1, 0, 0), b.dir(0, 1, 0)), b.dir(0, 0, 1));
      const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung Fenster hoch',$,$,#${b.place(b.storeys.eg.pl, 20, 0, 0)},#${b.shape([solid])},$,.OPENING.)`);
      b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
      const win = b.add(`IFCWINDOW(${b.guid()},$,'Fenster hoch',$,$,#${b.place(b.storeys.eg.pl, 20, 5, 3.5)},$,$,3.,1.,.WINDOW.,$,$)`);
      b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${win})`);
      b.contain(b.storeys.eg.id, wall);
      b.contain(b.storeys.eg.id, win);
    });
    const win = facts.candidates.find((c) => c.name === 'Fenster hoch');
    expect(win).toBeDefined();
    expect(win).toMatchObject({ category: 'window', levelBasis: 'opening-body-bottom' });
    expect(win!.level).toBeCloseTo(500.5, 3);
  });
});

describe('an external stair whose lower part the body hides', () => {
  /** A stair east of the house in the ground storey; `items` gets its upper extrusion (local z 0..1) and returns the Body items. */
  const stair = (items: (b: Extra, upper: number) => number[]) => (b: Extra) => {
    const upper = b.rectExtrusion(0, 0, 2, 2, 1, b.axis(0, 0, 0), b.dir(0, 0, 1));
    const s = b.add(`IFCSTAIR(${b.guid()},$,'Aussentreppe',$,$,#${b.place(b.storeys.eg.pl, 25, -5, 0)},#${b.shape(items(b, upper))},$,.STRAIGHT_RUN_STAIR.)`);
    b.contain(b.storeys.eg.id, s);
  };
  const names = async (items: (b: Extra, upper: number) => number[]) => (await extract(stair(items))).candidates.map((c) => c.name);

  it('a UNION of an upper and a lower solid is kept (its lower solid reaches 2 m below ground)', async () => {
    expect(await names((b, upper) => {
      const lower = b.rectExtrusion(0, 0, 2, 2, 2, b.axis(0, 0, -2), b.dir(0, 0, 1)); // z -2..0
      return [b.add(`IFCBOOLEANRESULT(.UNION.,#${upper},#${lower})`)];
    })).toContain('Aussentreppe');
  });
  it('an upper extrusion next to an unreadable body item is kept', async () => {
    expect(await names((b, upper) => [upper, b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`)])).toContain('Aussentreppe');
  });
  it('a readable body reaching 0.2 m below the ground storey is kept (it does not lie wholly above it)', async () => {
    expect(await names((b) => [b.rectExtrusion(0, 0, 2, 2, 1.2, b.axis(0, 0, -0.2), b.dir(0, 0, 1))])).toContain('Aussentreppe');
  });
  it('control: an upper extrusion alone, or one with a DIFFERENCE cut, still leads up and is skipped', async () => {
    expect(await names((_b, upper) => [upper])).not.toContain('Aussentreppe');
    expect(await names((b, upper) => {
      const cut = b.rectExtrusion(0, 0, 1, 1, 1, b.axis(0, 0, 0), b.dir(0, 0, 1));
      return [b.add(`IFCBOOLEANRESULT(.DIFFERENCE.,#${upper},#${cut})`)];
    })).not.toContain('Aussentreppe');
  });
});

describe('an IfcMapConversion.Scale of 0', () => {
  it('is refused, not read as 1 (which in a millimetre model put the house 22 km wide past the unit-ambiguity refusal)', async () => {
    for (const lengthUnit of ['METRE', 'MILLIMETRE'] as const) {
      const store = await parseStep(syntheticHouse({ verticalDatum: 'LN02', lengthUnit, scale: 0 }));
      expect(() => extractModelFacts(store, { expectedCrs: 'EPSG:2056' })).toThrow(FloodCheckRefusal);
      try {
        extractModelFacts(store, { expectedCrs: 'EPSG:2056' });
      } catch (e) {
        expect((e as FloodCheckRefusal).code).toBe('georeference-implausible');
      }
    }
  });
});
