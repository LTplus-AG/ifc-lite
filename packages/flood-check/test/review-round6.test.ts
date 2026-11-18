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
  it('a slab with one outer FootPrint curve and a Body profile with a courtyard void is not complete, so the courtyard door is kept', async () => {
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
    // The Body's hole is read under the FootPrint and, with no slab above, is a courtyard: never a complete outline.
    expect(facts.footprint.quality?.worst).toBe('courtyard-ring');
    expect(facts.footprint.courtyardRings).toHaveLength(1);
    expect(facts.candidates.map((c) => c.name)).toContain('Hoftür');
  });
});

describe('review of #10486 at c39120ef8: one description of the allowance, the value applied is the value reported', () => {
  it('with doors at +0.0 m and +0.3 m, the withheld note names the highest door and the 0.30 m that was applied', async () => {
    const { boxFacts, candidate, CODE, E0, N0, syntheticRaster } = await import('./helpers.js');
    const outside = (p: { x: number; y: number }) => !(p.x > E0 && p.x < E0 + 20 && p.y > N0 && p.y < N0 + 10);
    const ras = syntheticRaster(E0 - 10, N0 - 10, 80, 60, 0.5, (p) => (outside(p) ? CODE['depth-0.1-0.25'] : CELL_NO_RUNOFF));
    const doors = [
      candidate({ expressId: 1, position: { x: E0 + 15, y: N0 }, level: 500.3, storeyId: 10 }),
      candidate({ expressId: 2, position: { x: E0 + 5, y: N0 + 10 }, level: 500.0, storeyId: 10 }),
    ];
    const run = (level: number) =>
      checkFloodExposure(boxFacts([...doors, candidate({ expressId: 3, name: 'Fenster', category: 'window', position: { x: E0 + 20, y: N0 + 5 }, level, storeyId: 10 })]), ras, flatTerrain(500), opts);
    const probe = run(510);
    const m = probe.margin.margin!;
    const a = probe.heightReference.allowance!;
    expect(a).toBeCloseTo(0.3, 6);
    // Between m and m + a above the class: withheld, and the note states the rule and the number actually applied.
    const between = run(500 + 0.25 + m + a / 2).results.find((x) => x.candidate.name === 'Fenster')!;
    expect(between.outcome).toBe('within-class-range');
    const note = between.favourableWithheldBecause.join();
    expect(note).toMatch(/height of the highest ground-storey door above its adjacent terrain/);
    expect(note).toMatch(new RegExp(`further ${a.toFixed(2)} m`));
    expect(note).not.toMatch(/lowest/);
    // Beyond m + a: above the mapped class range, so the threshold applied is exactly m + a.
    expect(run(500 + 0.25 + m + a + 0.01).results.find((x) => x.candidate.name === 'Fenster')!.outcome).toBe('above-mapped-class-range');
  });
});

describe('the merge-queue failure on MiniBIM: a slab hole is read, and only an open one is a courtyard', () => {
  /** The ground slab (0..20 x 0..10) with a hole 6..14 x 3..7; `roofed` adds an upper-storey slab without one. */
  const holed = (roofed: boolean) => (b: Extra) => {
    const pt = (x: number, y: number) => b.add(`IFCCARTESIANPOINT((${x}.,${y}.))`);
    const loop = (pts: Array<[number, number]>) => b.add(`IFCPOLYLINE((${[...pts, pts[0]].map(([x, y]) => `#${pt(x, y)}`).join(',')}))`);
    const profile = b.add(`IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#${loop([[0, 0], [20, 0], [20, 10], [0, 10]])},(#${loop([[6, 3], [14, 3], [14, 7], [6, 7]])}))`);
    const solid = b.add(`IFCEXTRUDEDAREASOLID(#${profile},#${b.axis(0, 0, 0)},#${b.dir(0, 0, -1)},0.3)`);
    b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Bodenplatte gelocht',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([solid])},$,.FLOOR.)`));
    if (roofed) {
      const deck = b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
      b.contain(b.storeys.og.id, b.add(`IFCSLAB(${b.guid()},$,'Decke OG',$,$,#${b.place(b.storeys.og.pl, 0, 0, 0)},#${b.shape([deck])},$,.FLOOR.)`));
    }
  };
  const outcomeOf = (facts: Awaited<ReturnType<typeof extract>>, name: string) =>
    checkFloodExposure(facts, raster(() => CELL_NO_RUNOFF), flatTerrain(499.95), opts).results.find((x) => x.candidate.name === name)!;

  it('a hole roofed by the slab above is interior: the outline is complete (noted), and the street door is not withheld by it', async () => {
    const facts = await extract(holed(true), false);
    expect(facts.footprint.quality?.worst).toBe('complete');
    expect(facts.footprint.courtyardRings).toBeUndefined();
    expect(facts.footprint.quality?.notes.join()).toMatch(/roofed by slab/);
    expect(outcomeOf(facts, 'Haustür').outcome).toBe('no-runoff-mapped');
  });

  it('a hole open to the sky is a courtyard guarded locally: the street door far from it is not withheld', async () => {
    const facts = await extract(holed(false), false);
    expect(facts.footprint.quality?.worst).toBe('courtyard-ring');
    expect(outcomeOf(facts, 'Haustür').outcome).toBe('no-runoff-mapped');
  });
});

describe('review of #10486 at 5cc3b584c: a hole is roofed only over its whole area; on doubt it is a courtyard', () => {
  type Pts = Array<[number, number]>;
  /** A ground slab 0..20 x 0..20 with `hole`, and above it the slabs `upper` (outer, holes). */
  const build = (hole: Pts, upper: Array<{ outer: Pts; holes: Pts[] }>) => (b: Extra) => {
    const pt = (x: number, y: number) => b.add(`IFCCARTESIANPOINT((${x},${y}))`);
    const loop = (pts: Pts) => b.add(`IFCPOLYLINE((${[...pts, pts[0]].map(([x, y]) => `#${pt(x, y)}`).join(',')}))`);
    const slab = (storey: { pl: number; id: number }, name: string, outer: Pts, holes: Pts[]) => {
      const prof = holes.length
        ? b.add(`IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#${loop(outer)},(${holes.map((h) => `#${loop(h)}`).join(',')}))`)
        : b.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#${loop(outer)})`);
      const solid = b.add(`IFCEXTRUDEDAREASOLID(#${prof},#${b.axis(0, 0, 0)},#${b.dir(0, 0, -1)},0.3)`);
      b.contain(storey.id, b.add(`IFCSLAB(${b.guid()},$,'${name}',$,$,#${b.place(storey.pl, 0, 0, 0)},#${b.shape([solid])},$,.FLOOR.)`));
    };
    const square: Pts = [[0, 0], [20, 0], [20, 20], [0, 20]];
    slab(b.storeys.eg, 'EG', square, [hole]);
    upper.forEach((u, k) => slab(b.storeys.og, `OG ${k}`, u.outer, u.holes));
  };
  const square: Pts = [[0, 0], [20, 0], [20, 20], [0, 20]];
  const run = async (hole: Pts, upper: Array<{ outer: Pts; holes: Pts[] }>) => (await extract(build(hole, upper), false)).footprint;

  // The finding's L, shifted by (5, 5): its vertex mean (9, 9) lies in slab material, not in the hole.
  const L: Pts = [[5, 5], [15, 5], [15, 7], [7, 7], [7, 15], [5, 15]];
  it('an L-shaped courtyard open through the floor above is a courtyard, though slab material above covers its vertex mean', async () => {
    const fp = await run(L, [{ outer: square, holes: [L] }]);
    expect(fp.courtyardRings).toHaveLength(1);
    expect(fp.quality?.worst).toBe('courtyard-ring');
  });

  it('a U-shaped courtyard open above is a courtyard (its vertex mean lies between the arms, in slab material)', async () => {
    const U: Pts = [[5, 5], [15, 5], [15, 15], [13, 15], [13, 7], [7, 7], [7, 15], [5, 15]];
    expect((await run(U, [{ outer: square, holes: [U] }])).courtyardRings).toHaveLength(1);
  });

  it('a hole half covered by a balcony slab is a courtyard (partly roofed is open)', async () => {
    const hole: Pts = [[6, 3], [14, 3], [14, 7], [6, 7]];
    const fp = await run(hole, [{ outer: square, holes: [hole] }, { outer: [[6, 3], [11, 3], [11, 7], [6, 7]], holes: [] }]);
    expect(fp.courtyardRings).toHaveLength(1);
  });

  it('a hole under a slab that itself has a hole above part of it is a courtyard', async () => {
    const hole: Pts = [[6, 3], [14, 3], [14, 7], [6, 7]];
    expect((await run(hole, [{ outer: square, holes: [[[12, 3], [14, 3], [14, 7], [12, 7]]] }])).courtyardRings).toHaveLength(1);
  });

  it('control: a hole wholly roofed by the slab above stays interior', async () => {
    const fp = await run([[6, 3], [14, 3], [14, 7], [6, 7]], [{ outer: square, holes: [] }]);
    expect(fp.courtyardRings).toBeUndefined();
    expect(fp.quality?.notes.join()).toMatch(/wholly roofed/);
  });
});
