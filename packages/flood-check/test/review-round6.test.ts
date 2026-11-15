/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The automated review of #10403 at 0c9e7710d, probed end to end (facts,
 * check, outcome) on the part-2 branch: an empty footprint is unknown, not
 * infinitely far; an uncertain position never supports an exclusion; a CRS
 * name contradicted by its own WKT identifier is refused.
 */

import { describe, expect, it } from 'vitest';
import { checkFloodExposure } from '../src/check/check.js';
import { FloodCheckRefusal } from '../src/errors.js';
import { extractModelFacts } from '../src/model/extract.js';
import { CELL_NO_RUNOFF } from '../src/types.js';
import { CONFIRMED, flatTerrain, NO_OTHER_BUILDINGS } from './helpers.js';
import { raster } from './candidate-fixtures.js';
import { parseStep, syntheticHouse, type Extra } from './synthetic-model.js';

const opts = { renderingConfirmation: CONFIRMED, otherBuildings: NO_OTHER_BUILDINGS };
const extract = async (extra: (b: Extra) => void, slab = true) =>
  extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', slab, extra })), { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });

describe('finding 1: with no footprint, inside and outside are unknown', () => {
  it('an interior basement stair with no outline to test against is kept for that reason, not as "placed outside", and gets no favourable outcome', async () => {
    const facts = await extract((b) => {
      const body = b.shape([b.rectExtrusion(0, 0, 1, 3, 3, b.axis(0, 0, -3), b.dir(0, 0, 1))]);
      b.contain(b.storeys.ug.id, b.add(`IFCSTAIR(${b.guid()},$,'Kellertreppe innen',$,$,#${b.place(b.storeys.ug.pl, 10, 5, 3)},#${body},$,.STRAIGHT_RUN_STAIR.)`));
    }, false);
    const stair = facts.candidates.find((c) => c.name === 'Kellertreppe innen')!;
    expect(stair.selectedBecause).not.toMatch(/placed outside the footprint/);
    expect(stair.selectedBecause).toMatch(/no footprint/);
    const r = checkFloodExposure(facts, raster(() => CELL_NO_RUNOFF), flatTerrain(499.95), opts);
    for (const x of r.results) expect(['above-mapped-class-range', 'no-runoff-mapped']).not.toContain(x.outcome);
  });
});

describe('finding 2: an uncertain position never supports an exclusion', () => {
  it('a door stating IsExternal = false whose filled opening is only partly readable is kept, with the statement noted', async () => {
    const facts = await extract((b) => {
      const eg = b.storeys.eg;
      const wall = b.add(`IFCWALL(${b.guid()},$,'Wand ohne Pset',$,$,#${b.place(eg.pl, 0, 0, 0)},$,$,.STANDARD.)`);
      b.contain(eg.id, wall);
      // A readable piece 3 m inside the building and an unreadable piece that may reach the east façade.
      const inner = b.rectExtrusion(17, 5, 1, 0.4, 2.1, b.axis(0, 0, 0), b.dir(0, 0, 1));
      const brep = b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`);
      const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung teilweise',$,$,#${b.place(eg.pl, 0, 0, 0)},#${b.shape([inner, brep])},$,.OPENING.)`);
      b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
      const leaf = b.shape([b.rectExtrusion(0, 0, 1, 0.1, 2.1, b.axis(0, 0, 0), b.dir(0, 0, 1))]);
      const door = b.add(`IFCDOOR(${b.guid()},$,'Tür intern?',$,$,#${b.place(eg.pl, 17, 5, 0)},#${leaf},$,2.1,1.,.DOOR.,$,$)`);
      b.pset(door, 'Pset_DoorCommon', 'IsExternal', 'IFCBOOLEAN(.F.)');
      b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${door})`);
      b.contain(eg.id, door);
    });
    const door = facts.candidates.find((c) => c.name === 'Tür intern?');
    expect(door).toMatchObject({ positionIsUncertain: true });
    expect(door?.selectedBecause).toMatch(/states IsExternal = false/);
    const r = checkFloodExposure(facts, raster(() => CELL_NO_RUNOFF), flatTerrain(499.95), opts);
    expect(['above-mapped-class-range', 'no-runoff-mapped']).not.toContain(r.results.find((x) => x.candidate.name === 'Tür intern?')!.outcome);
  });
});

describe('finding 3: a CRS name contradicted by its own WKT identifier is refused', () => {
  it('Name EPSG:2056 with a WKT identifying EPSG:21781: refused as crs-mismatch, naming both', async () => {
    const text = syntheticHouse({ verticalDatum: 'LN02', crsName: 'EPSG:2056' });
    const crsId = /#(\d+)=IFCPROJECTEDCRS\(/.exec(text)![1];
    const withWkt = await parseStep(text.replace(/ENDSEC;\s*END-ISO-10303-21;/, `#999999=IFCWELLKNOWNTEXT('PROJCRS["CH1903 / LV03",ID["EPSG",21781]]',#${crsId});\nENDSEC;\nEND-ISO-10303-21;`));
    let err: unknown;
    try {
      extractModelFacts(withWkt, { expectedCrs: 'EPSG:2056' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FloodCheckRefusal);
    expect(err).toMatchObject({ code: 'crs-mismatch' });
    expect((err as Error).message).toMatch(/EPSG:2056.*EPSG:21781/);
  });
});

describe('the automated review of 14fabe313: a FootPrint curve does not hide the Body\'s voids', () => {
  it('a slab with one outer FootPrint curve and a Body profile with a courtyard void is voids-filled, so the courtyard door is kept', async () => {
    const facts = await extract((b) => {
      const eg = b.storeys.eg;
      const pt = (x: number, y: number) => b.add(`IFCCARTESIANPOINT((${x}.,${y}.))`);
      const loop = (pts: Array<[number, number]>) => b.add(`IFCPOLYLINE((${[...pts, pts[0]].map(([x, y]) => `#${pt(x, y)}`).join(',')}))`);
      const outer = [[0, 0], [30, 0], [30, 30], [0, 30]] as Array<[number, number]>;
      const court = [[10, 10], [20, 10], [20, 20], [10, 20]] as Array<[number, number]>;
      const profile = b.add(`IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#${loop(outer)},(#${loop(court)}))`);
      const solid = b.add(`IFCEXTRUDEDAREASOLID(#${profile},#${b.axis(0, 0, 0)},#${b.dir(0, 0, -1)},0.3)`);
      const body = b.add(`IFCSHAPEREPRESENTATION(#${b.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#${b.add("IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,$,$)")},$,.MODEL_VIEW.,$)`)},'Body','SweptSolid',(#${solid}))`);
      const fp = b.add(`IFCSHAPEREPRESENTATION(#${b.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('FootPrint','Model',*,*,*,*,#${b.add("IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',2,1.E-05,$,$)")},$,.PLAN_VIEW.,$)`)},'FootPrint','Curve2D',(#${loop(outer)}))`);
      b.contain(eg.id, b.add(`IFCSLAB(${b.guid()},$,'Platte Hof',$,$,#${b.place(eg.pl, 0, 0, 0)},#${b.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${fp},#${body}))`)},$,.FLOOR.)`));
      const leaf = b.shape([b.rectExtrusion(0, 0, 1, 0.1, 2.1, b.axis(0, 0, 0), b.dir(0, 0, 1))]);
      b.contain(eg.id, b.add(`IFCDOOR(${b.guid()},$,'Hoftür',$,$,#${b.place(eg.pl, 15, 10, 0)},#${leaf},$,2.1,1.,.DOOR.,$,$)`));
    }, false);
    expect(facts.footprint.source).toBe('slab-outline-voids-filled');
    expect(facts.candidates.map((c) => c.name)).toContain('Hoftür');
  });
});
