/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review round on head af83417c: a reader must report every item it was
 * given, not "the first one" (outlines); one caller's abort must not reach
 * another caller's rendering check (provider).
 */

import { describe, expect, it } from 'vitest';
import { extractModelFacts } from '../src/model/extract.js';
import { footprintConcerns } from '../src/model/facts.js';
import { insideFootprint, prepareFootprint } from '../src/region.js';
import { mapOf, parseStep, syntheticHouse, type Extra } from './synthetic-model.js';

describe('a slab body with two disjoint extrusions (model half; the check half is in reader-completeness-check)', () => {
  it('gives an outline ring for each, so the second wing is inside a complete footprint', async () => {
    const twoWings = (b: Extra) => {
      const wingA = b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
      const wingB = b.rectExtrusion(35, 5, 10, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
      b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Platte zwei Flügel',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([wingA, wingB])},$,.FLOOR.)`));
    };
    const facts = extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', slab: false, extra: twoWings })), { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });
    expect(facts.footprint.rings).toHaveLength(2);
    expect(footprintConcerns(facts.footprint).worst).toBe('complete');
    expect(insideFootprint(prepareFootprint(facts.footprint), mapOf(35, 5))).toBe(true);
  });

  it('a slab cut by a Boolean DIFFERENCE (a courtyard) is never a complete outline: the cut is read as a hole, open above, a courtyard', async () => {
    const cut = (b: Extra) => {
      const outer = b.rectExtrusion(15, 15, 30, 30, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
      const court = b.rectExtrusion(15, 15, 28, 28, 1, b.axis(0, 0, 0.5), b.dir(0, 0, -1));
      b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Platte Hof',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([b.add(`IFCBOOLEANRESULT(.DIFFERENCE.,#${outer},#${court})`)])},$,.FLOOR.)`));
    };
    const facts = extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', slab: false, extra: cut })), { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });
    // Since the follow-up the DIFFERENCE's through cut is read as a hole; with no slab above it is a courtyard (guarded locally).
    expect(facts.footprint.source).toBe('slab-outline');
    expect(facts.footprint.courtyardRings).toHaveLength(1);
    expect(facts.footprint.quality?.worst).toBe('courtyard-ring');
  });
});

describe('the audit: no reader stops at the first item or match', () => {
  it('a slab body with one readable and one unreadable item is partial, with the readable ring kept', async () => {
    const facts = extractModelFacts(await parseStep(syntheticHouse({
      verticalDatum: 'LN02',
      slab: false,
      extra: (b) => {
        const wingA = b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
        const brep = b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`);
        b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Platte teils',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([wingA, brep])},$,.FLOOR.)`));
      },
    })), { expectedCrs: 'EPSG:2056' });
    expect(facts.footprint.rings).toHaveLength(1);
    expect(footprintConcerns(facts.footprint).worst).toBe('partial');
    expect(facts.footprint.quality?.unreadable.map((u) => u.reason).join()).toMatch(/only in part \(1 of 2 items\)/);
  });

  it('a wall axis with one readable and one unreadable curve is partial', async () => {
    const facts = extractModelFacts(await parseStep(syntheticHouse({
      verticalDatum: 'LN02',
      slab: false,
      extra: (b) => {
        const good = b.add(`IFCPOLYLINE((#${b.pt2(20, 0)},#${b.pt2(20, 10)}))`);
        const bad = b.add(`IFCCOMPOSITECURVE((),.F.)`);
        const wall = b.add(`IFCWALL(${b.guid()},$,'Wand Ost',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([good, bad], 'Axis', 'Curve2D')},$,.STANDARD.)`);
        b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
        b.contain(b.storeys.eg.id, wall);
      },
    })), { expectedCrs: 'EPSG:2056' });
    expect(facts.footprint.quality?.unreadable.map((u) => u.reason).join()).toMatch(/axis can be read only in part \(1 of 2 curves\)/);
    expect(footprintConcerns(facts.footprint).partial).toBe(true);
  });

  it('two same-named property sets that disagree on IsExternal keep the element in the façade', async () => {
    const facts = extractModelFacts(await parseStep(syntheticHouse({
      verticalDatum: 'LN02',
      extra: (b) => {
        const door = b.add(`IFCDOOR(${b.guid()},$,'Tür zwei Psets',$,$,#${b.place(b.storeys.eg.pl, 10, 5, 0)},#${b.shape([b.rectExtrusion(0, 0, 1, 0.1, 2.1, b.axis(0, 0, 0), b.dir(0, 0, 1))])},$,2.1,1.,.DOOR.,$,$)`);
        b.pset(door, 'Pset_DoorCommon', 'IsExternal', 'IFCBOOLEAN(.F.)');
        b.pset(door, 'Pset_DoorCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
        b.contain(b.storeys.eg.id, door);
      },
    })), { expectedCrs: 'EPSG:2056' });
    expect(facts.candidates.find((c) => c.name === 'Tür zwei Psets')?.selectedBecause).toMatch(/IsExternal/);
  });

  it('an opening filled twice is kept as an upper estimate: no filling\'s OverallHeight bounds it (audit finding 8), the first one\'s least of all', async () => {
    const facts = extractModelFacts(await parseStep(syntheticHouse({
      verticalDatum: 'LN02',
      extra: (b) => {
        // An upper-storey opening on the east face (504.5 m), its body unreadable, with no host: judged on its own.
        const brep = b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`);
        const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung doppelt',$,$,#${b.place(b.storeys.og.pl, 20, 5, 0.5)},#${b.shape([brep])},$,.OPENING.)`);
        // Two windows filling it, both stating IsExternal = false (skipped): 0.5 m tall (bound 504 m) first, 3 m tall (bound 501.5 m) second.
        for (const [name, h] of [['Fenster klein', '0.5'], ['Fenster gross', '3.']] as const) {
          const w = b.add(`IFCWINDOW(${b.guid()},$,'${name}',$,$,#${b.place(b.storeys.og.pl, 20, 5, 0.5)},$,$,${h},1.,.WINDOW.,$,$)`);
          b.pset(w, 'Pset_WindowCommon', 'IsExternal', 'IFCBOOLEAN(.F.)');
          b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${w})`);
          b.contain(b.storeys.og.id, w);
        }
      },
    })), { expectedCrs: 'EPSG:2056', groundStorey: 'EG' }); // stated, so a wrong bound would exclude it (a guessed storey keeps everything)
    expect(facts.candidates.find((c) => c.name === 'Öffnung doppelt')).toMatchObject({ levelIsUpperEstimate: true });
  });
});
