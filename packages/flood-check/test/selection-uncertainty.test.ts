/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review round on head 4fa60bd3: an element must not be excluded, or cleared,
 * on data that is known to be incomplete or stale.
 */

import { describe, expect, it } from 'vitest';
import { extractModelFacts } from '../src/model/extract.js';
import { parseStep, syntheticHouse, type Extra } from './synthetic-model.js';

const extract = async (extra: (b: Extra) => void) =>
  extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', extra })), { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });

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
    const facts = await extract(window('eg', '1.'));
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
      b.contain(b.storeys.eg.id, b.add(`IFCDOOR(${b.guid()},$,'Innentür',$,$,#${b.place(b.storeys.eg.pl, 10, 5, 0)},#${b.shape([b.rectExtrusion(0, 0, 1, 0.1, 2.1, b.axis(0, 0, 0), b.dir(0, 0, 1))])},$,2.1,1.,.DOOR.,$,$)`));
    });
    expect(facts.footprint.partial).toBe(true);
    expect(facts.candidates.find((c) => c.name === 'Fenster Anbau')?.selectedBecause).toMatch(/footprint is partial/);
    expect(facts.candidates.map((c) => c.name)).not.toContain('Innentür');
  });
});
