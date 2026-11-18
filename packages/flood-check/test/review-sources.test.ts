/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The automated review of #10403 at a46ce9cb0: every source walked for the
 * footprint and not used is recorded; a level read from a clipped body is a
 * lower bound, not exact; an ambiguous ground-storey name is refused.
 */

import { describe, expect, it } from 'vitest';
import { FloodCheckRefusal } from '../src/errors.js';
import { extractModelFacts } from '../src/model/extract.js';
import { parseStep, syntheticHouse, type Extra } from './synthetic-model.js';

const extract = async (extra: (b: Extra) => void, slab = true) =>
  extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', slab, extra })), { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });
const brep = (b: Extra) => b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`);
const externalWall = (b: Extra, placement: string, shape = '$') => {
  const w = b.add(`IFCWALL(${b.guid()},$,'Wand aussen',$,$,${placement},${shape},$,.STANDARD.)`);
  b.pset(w, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
  b.contain(b.storeys.eg.id, w);
  return w;
};

describe('every footprint source walked and not used is recorded, and the footprint is partial', () => {
  const cases: Array<[string, boolean, (b: Extra) => number]> = [
    ['a ground slab whose outline cannot be read', true, (b) => {
      const s = b.add(`IFCSLAB(${b.guid()},$,'Platte Brep',$,$,#${b.place(b.storeys.eg.pl, 20, 0, 0)},#${b.shape([brep(b)], 'Body', 'Brep')},$,.FLOOR.)`);
      b.contain(b.storeys.eg.id, s);
      return s;
    }],
    ['a ground slab ring under 1 m²', true, (b) => {
      const s = b.add(`IFCSLAB(${b.guid()},$,'Podest',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([b.rectExtrusion(21, 5, 0.8, 1, 0.2, b.axis(0, 0, 0), b.dir(0, 0, -1))])},$,.FLOOR.)`);
      b.contain(b.storeys.eg.id, s);
      return s;
    }],
    ['an external wall whose placement cannot be read, beside a readable slab (the wall check)', true, (b) => externalWall(b, '$')],
    ['an external wall whose axis cannot be read, beside a readable slab (the wall check)', true, (b) => externalWall(b, `#${b.place(b.storeys.eg.pl, 0, 0, 0)}`, `#${b.shape([brep(b)], 'Axis', 'Curve2D')}`)],
    ['an external wall whose placement cannot be read, with no slab (the wall outline)', false, (b) => externalWall(b, '$')],
  ];
  it.each(cases)('%s', async (_label, slab, add) => {
    let id = 0;
    const facts = await extract((b) => {
      id = add(b);
    }, slab);
    expect(facts.footprint.quality?.unreadable.map((u) => u.expressId)).toContain(id);
    expect(facts.footprint.partial).toBe(true);
    expect(facts.footprint.fromElements).not.toContain(id);
  });
});

describe('a level read from a clipped body is a lower bound, never exact', () => {
  it('an opening whose DIFFERENCE body may have lost its bottom is reported as a lower bound', async () => {
    const facts = await extract((b) => {
      const eg = b.storeys.eg;
      const wall = externalWall(b, `#${b.place(eg.pl, 20, 0, 0)}`);
      const first = b.rectExtrusion(19.8, 5, 0.4, 1, 2, b.axis(0, 0, 0), b.dir(0, 0, 1)); // z 0..2
      const cut = b.rectExtrusion(19.8, 5, 1, 2, 1, b.axis(0, 0, -0.5), b.dir(0, 0, 1)); // removes z -0.5..0.5
      const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung unten geschnitten',$,$,#${b.place(eg.pl, 0, 0, 0)},#${b.shape([b.add(`IFCBOOLEANRESULT(.DIFFERENCE.,#${first},#${cut})`)])},$,.OPENING.)`);
      b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
    });
    const o = facts.candidates.find((c) => c.name === 'Öffnung unten geschnitten')!;
    expect(o).toMatchObject({ levelIsLowerBound: true });
    expect(o.notes?.join()).toMatch(/lower bound/);
  });
});

describe('an ambiguous ground-storey name is refused', () => {
  it('two buildings each with a storey named EG: refused, listing both, and the GlobalId picks one', async () => {
    let otherGuid = '';
    const store = await parseStep(syntheticHouse({
      verticalDatum: 'LN02',
      extra: (b) => {
        const pl = b.place(b.site.pl, 60, 0, 0);
        const bld = b.add(`IFCBUILDING(${b.guid()},$,'Nebengebäude',$,$,#${pl},$,$,.ELEMENT.,$,$,$)`);
        b.add(`IFCRELAGGREGATES(${b.guid()},$,$,$,#${b.site.id},(#${bld}))`);
        otherGuid = '2OtherEGStorey000000001';
        const st = b.add(`IFCBUILDINGSTOREY('${otherGuid}',$,'EG',$,$,#${b.place(pl, 0, 0, 0)},$,$,.ELEMENT.,0.)`);
        b.add(`IFCRELAGGREGATES(${b.guid()},$,$,$,#${bld},(#${st}))`);
      },
    }));
    let err: unknown;
    try {
      extractModelFacts(store, { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FloodCheckRefusal);
    expect(err).toMatchObject({ code: 'ambiguous-building' });
    expect((err as Error).message).toMatch(new RegExp(`2 storeys.*${otherGuid}.*GlobalId or express id`));
    expect(extractModelFacts(store, { expectedCrs: 'EPSG:2056', groundStorey: otherGuid }).groundStorey).toMatchObject({ basis: 'given' });
  });
});
