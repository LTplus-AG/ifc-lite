/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The independent audit of the side branch (nine findings and the cheap
 * fail-closed suspicions), each as the auditor's reproduction asserting the
 * fixed behaviour.
 */

import { describe, expect, it } from 'vitest';
import { BAFU_CLASSES } from '../src/bafu/dataset.js';
import { bafuCovers } from '../src/bafu/coverage.js';
import { checkFloodExposure } from '../src/check/check.js';
import { runFloodCheck } from '../src/check/run.js';
import { FloodCheckRefusal } from '../src/errors.js';
import { commonPsets } from '../src/model/candidate-base.js';
import { extractModelFacts } from '../src/model/extract.js';
import { footprintConcerns } from '../src/model/facts.js';
import { toPropertySets } from '../src/psets.js';
import { CELL_NO_RUNOFF, type HazardProvider, type MapPoint, type OtherBuildingFootprints } from '../src/types.js';
import { boxFacts, candidate, CODE, CONFIRMED, E0, flatTerrain, N0, NO_OTHER_BUILDINGS, syntheticRaster } from './helpers.js';
import { localOf, raster as localRaster, zooForFixtures } from './candidate-fixtures.js';
import { parseStep, syntheticHouse, type Extra } from './synthetic-model.js';

const deep = CODE['depth-gt-0.25'];
const mid = CODE['depth-0.1-0.25'];
const extract = async (extra: (b: Extra) => void, slab = true) =>
  extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', slab, extra })), { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });
const leafOf = (b: Extra, w = 1, h = 2.1) => b.shape([b.rectExtrusion(0, 0, w, 0.1, h, b.axis(0, 0, 0), b.dir(0, 0, 1))]);

describe('finding 1: the height reference is confirmed only by a known ground storey whose doors agree', () => {
  const T = 499.7;
  const outside = (p: MapPoint) => !(p.x > E0 && p.x < E0 + 20 && p.y > N0 && p.y < N0 + 10);
  const ras = () => syntheticRaster(E0 - 10, N0 - 10, 80, 60, 0.5, (p) => (outside(p) ? mid : CELL_NO_RUNOFF));
  const opts = { renderingConfirmation: CONFIRMED, otherBuildings: NO_OTHER_BUILDINGS };

  it('(a) a guessed ground storey (the basement) leaves the reference unconfirmed; the truly exposed door is not above the range', () => {
    const e = 4;
    const facts = boxFacts(
      [
        candidate({ expressId: 1, name: 'Kellertür', position: { x: E0 + 5, y: N0 }, level: 497.0 + e, storeyId: 9 }),
        candidate({ expressId: 2, name: 'Haustür', position: { x: E0 + 15, y: N0 }, level: 499.75 + e, storeyId: 10 }),
      ],
      {
        storeys: [{ expressId: 9, globalId: 's9', name: 'UG', level: 497 + e }, { expressId: 10, globalId: 's10', name: 'EG', level: 500 + e }],
        groundStorey: { expressId: 9, level: 497 + e, basis: 'lowest-storey' },
      },
    );
    const r = checkFloodExposure(facts, ras(), flatTerrain(T), opts);
    expect(r.heightReference.status).toBe('unconfirmed');
    expect(r.heightReference.unconfirmedBecause.join()).toMatch(/ground storey was guessed \(lowest-storey\)/);
    expect(r.results.map((x) => x.outcome)).not.toContain('above-mapped-class-range');
  });

  it('(b) a sunken ground-storey door disagrees with the front door: unconfirmed, and the front door is not above the range', () => {
    const e = 2;
    const facts = boxFacts(
      [
        candidate({ expressId: 1, name: 'Haustür', position: { x: E0 + 15, y: N0 }, level: 499.75 + e, storeyId: 10 }),
        candidate({ expressId: 2, name: 'Tür Sitzplatz (abgesenkt)', position: { x: E0 + 5, y: N0 + 10 }, level: 497.7 + e, storeyId: 10 }),
      ],
      { groundStorey: { expressId: 10, level: 500 + e, basis: 'project-zero' } },
    );
    const r = checkFloodExposure(facts, ras(), flatTerrain(T), opts);
    expect(r.heightReference.status).toBe('unconfirmed');
    expect(r.heightReference.unconfirmedBecause.join()).toMatch(/disagree about their height above the terrain/);
    expect(r.results.find((x) => x.candidate.name === 'Haustür')!.outcome).not.toBe('above-mapped-class-range');
  });

  it('the allowance is the HIGHEST door height above terrain, and the residual-risk text says so', () => {
    const facts = boxFacts([
      candidate({ expressId: 1, position: { x: E0 + 15, y: N0 }, level: 500.3, storeyId: 10 }),
      candidate({ expressId: 2, position: { x: E0 + 5, y: N0 + 10 }, level: 500.0, storeyId: 10 }),
    ]);
    const r = checkFloodExposure(facts, ras(), flatTerrain(500), opts);
    expect(r.heightReference.status).toBe('confirmed');
    expect(r.heightReference.allowance).toBeCloseTo(0.3, 6);
    expect(r.heightReference.residualRisk.en).toMatch(/height of the highest ground-storey door/);
    expect(r.heightReference.residualRisk.de).toMatch(/höchsten Erdgeschosstür/);
  });
});

describe('finding 2: transparent counts as no runoff only with proof that it is open ground', () => {
  // House 20 x 10 m; a garage not in the model abuts its south façade (x 5..15, y -6..0), raised, so transparent.
  const garageRing: MapPoint[] = [{ x: E0 + 5, y: N0 - 6 }, { x: E0 + 15, y: N0 - 6 }, { x: E0 + 15, y: N0 }, { x: E0 + 5, y: N0 }];
  const inGarage = (p: MapPoint) => p.x > E0 + 5 && p.x < E0 + 15 && p.y > N0 - 6 && p.y < N0;
  const inHouse = (p: MapPoint) => p.x > E0 && p.x < E0 + 20 && p.y > N0 && p.y < N0 + 10;
  const ras = syntheticRaster(E0 - 10, N0 - 10, 80, 60, 0.5, (p) => (inGarage(p) || inHouse(p) ? CELL_NO_RUNOFF : deep));
  const facts = boxFacts([candidate({ position: { x: E0 + 10, y: N0 }, level: 500, storeyId: 10 })]);
  const run = (otherBuildings?: OtherBuildingFootprints) =>
    checkFloodExposure(facts, ras, flatTerrain(499.95), { renderingConfirmation: CONFIRMED, otherBuildings }).results[0];

  it('the reported case: with no source of other buildings, the door into the garage is not "no runoff mapped"', () => {
    expect(run()).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'other-buildings-unknown' });
  });
  it('a complete source listing the garage: its samples are inside another building', () => {
    expect(run({ ...NO_OTHER_BUILDINGS, rings: [garageRing] })).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'other-building' });
  });
  it('an incomplete source that misses the garage proves nothing', () => {
    expect(run({ ...NO_OTHER_BUILDINGS, complete: false })).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'other-buildings-unknown' });
  });
  it('only a complete source with the sample outside every footprint gives "no runoff mapped"', () => {
    expect(run(NO_OTHER_BUILDINGS).outcome).toBe('no-runoff-mapped');
  });

  it('on the classified path any transparent sample without a source withholds "above the mapped range"; exposed is unaffected', () => {
    const south = (p: MapPoint) => (p.y < N0 ? CODE['depth-0-0.1'] : CELL_NO_RUNOFF);
    const r2 = syntheticRaster(E0 - 10, N0 - 10, 80, 60, 0.5, south);
    const ref = candidate({ expressId: 99, position: { x: E0 + 10, y: N0 + 10 }, level: 500 });
    const high = candidate({ expressId: 2, position: { x: E0 + 20, y: N0 }, level: 503, storeyId: 11 }); // at the corner: samples south (class) and east (transparent)
    const low = candidate({ expressId: 3, position: { x: E0 + 5, y: N0 }, level: 500, storeyId: 11 });
    const without = checkFloodExposure(boxFacts([high, low, ref]), r2, flatTerrain(500), {});
    const withSource = checkFloodExposure(boxFacts([high, low, ref]), r2, flatTerrain(500), { otherBuildings: NO_OTHER_BUILDINGS });
    expect(without.results[0].outcome).toBe('within-class-range');
    expect(without.results[0].favourableWithheldBecause.join()).toMatch(/no complete source of other buildings' footprints/);
    expect(withSource.results[0].outcome).toBe('above-mapped-class-range');
    expect(without.results[1].outcome).toBe('exposed');
    expect(without.warnings.join()).toMatch(/No source of other buildings' footprints was supplied/);
    expect(without.otherBuildings).toEqual({ supplied: false, complete: false, count: 0, rejected: [], extent: null, provenance: null });
  });

  it('runFloodCheck fetches a buildings source for the check box and refuses one in another CRS', async () => {
    const boxes: unknown[] = [];
    const provider: HazardProvider = {
      id: 'stub', crs: 'EPSG:2056', classes: BAFU_CLASSES, extent: { minX: 2_000_000, minY: 1_000_000, maxX: 3_000_000, maxY: 1_400_000 }, modelCellSize: 1,
      fetchRaster: async () => ras, confirmRendering: async () => CONFIRMED,
    };
    const terrain = { crs: 'EPSG:2056', verticalCrs: 'EPSG:5728', verticalAccuracy: 0.3, heightAt: () => 499.95 };
    const buildings = { crs: 'EPSG:2056', footprints: (bbox: unknown) => { boxes.push(bbox); return { ...NO_OTHER_BUILDINGS, rings: [garageRing] }; } };
    const r = await runFloodCheck(facts, provider, terrain, { buildings });
    expect(boxes).toHaveLength(1);
    expect(r.results[0].unclassifiedReason).toBe('other-building');
    await expect(runFloodCheck(facts, provider, terrain, { buildings: { ...buildings, crs: 'EPSG:21781' } })).rejects.toMatchObject({ code: 'crs-mismatch' });
  });
});

describe('finding 3: skipped elements reach the result and the site property set', () => {
  it('results + skipped = walked can be checked from the payload alone', async () => {
    const facts = extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', extra: zooForFixtures })), { expectedCrs: 'EPSG:2056' });
    const r = checkFloodExposure(facts, localRaster(() => mid), flatTerrain(499.95), { renderingConfirmation: CONFIRMED });
    expect(r.skipped).toEqual(facts.skipped);
    expect(r.coverage).toEqual(facts.coverage);
    const site = Object.fromEntries(toPropertySets(r, BAFU_CLASSES).site.Properties.map((p) => [p.Name, p.NominalValue]));
    expect(r.results.length + (site.CountElementsSkipped as number)).toBe(site.CountElementsWalked);
    expect(site.ElementsSkippedByReason).toMatch(/3× no readable IfcLocalPlacement chain/);
  });
});

/** A wall along y = 0 with no IsExternal and a door at x = 5 with a readable body and a readable opening. */
function plainFacadeDoor(b: Extra) {
  const eg = b.storeys.eg;
  const wall = b.add(`IFCWALL(${b.guid()},$,'Wand ohne Pset',$,$,#${b.place(eg.pl, 0, 0, 0)},$,$,.STANDARD.)`);
  const hole = b.rectExtrusion(0, 0, 1, 2.1, 0.4, b.axis(5, -0.2, 1.05, b.dir(0, 1, 0), b.dir(1, 0, 0)), b.dir(0, 0, 1));
  const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung Terrassentür',$,$,#${b.place(eg.pl, 0, 0, 0)},#${b.shape([hole])},$,.OPENING.)`);
  b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
  const door = b.add(`IFCDOOR(${b.guid()},$,'Terrassentür',$,$,#${b.place(eg.pl, 5, 0, 0)},#${leafOf(b)},$,2.1,1.,.DOOR.,$,$)`);
  b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${door})`);
  b.contain(eg.id, wall);
  b.contain(eg.id, door);
}

describe('finding 4: a footprint larger or smaller than the building is recorded, and outside is never interior', () => {
  it('(a) a podium slab 3 m beyond the façade: oversized (hull-like), and the façade door is kept', async () => {
    const facts = await extract((b) => {
      plainFacadeDoor(b);
      const podium = b.rectExtrusion(10, 3.5, 20, 13, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1)); // y -3 .. 10
      b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Decke über UG',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([podium])},$,.FLOOR.)`));
    }, false);
    expect(facts.footprint.quality?.conditions).toContain('oversized');
    expect(footprintConcerns(facts.footprint).hullLike).toBe(true);
    expect(facts.candidates.find((c) => c.name === 'Terrassentür')?.selectedBecause).toMatch(/fills courtyards|beyond|hull/);
  });

  it('(b) a split level: the door 5 m outside the footprint is kept, and the footprint is partial', async () => {
    const facts = await extract((b) => {
      const { eg, ug } = b.storeys;
      b.contain(eg.id, b.add(`IFCSLAB(${b.guid()},$,'Platte West EG',$,$,#${b.place(eg.pl, 0, 0, 0)},#${b.shape([b.rectExtrusion(5, 5, 10, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1))])},$,.FLOOR.)`));
      b.contain(ug.id, b.add(`IFCSLAB(${b.guid()},$,'Platte Ost',$,$,#${b.place(ug.pl, 0, 0, 1.5)},#${b.shape([b.rectExtrusion(15, 5, 10, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1))])},$,.FLOOR.)`));
      const door = b.add(`IFCDOOR(${b.guid()},$,'Eingang Ost',$,$,#${b.place(eg.pl, 15, 0, 0)},#${leafOf(b)},$,2.1,1.,.DOOR.,$,$)`);
      b.contain(eg.id, door);
    }, false);
    expect(facts.candidates.find((c) => c.name === 'Eingang Ost')?.selectedBecause).toMatch(/outside the footprint, so it cannot be interior/);
    expect(facts.footprint.partial).toBe(true);
    expect(facts.footprint.quality?.notes.join()).toMatch(/stands 5\.00 m outside the footprint|reaches .* outside the footprint/);
  });
});

describe('finding 5: coverage travels with the raster; its absence is never favourable', () => {
  it('a building in the Büsingen enclave is outside coverage when the raster carries the BAFU perimeter', () => {
    const E = 2_693_800;
    const N = 1_284_000;
    const facts = boxFacts([candidate({ position: { x: E + 10, y: N }, level: 500, storeyId: 10 })], {
      footprint: { rings: [[{ x: E, y: N }, { x: E + 20, y: N }, { x: E + 20, y: N + 10 }, { x: E, y: N + 10 }]], source: 'given', fromElements: [] },
    });
    const ras = syntheticRaster(E - 10, N - 10, 80, 60, 0.5, (p) => (p.x < E - 8 ? mid : CELL_NO_RUNOFF), 'EPSG:2056', bafuCovers);
    const r = checkFloodExposure(facts, ras, flatTerrain(499.95), { otherBuildings: NO_OTHER_BUILDINGS });
    expect(r.results[0]).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'outside-coverage' });
  });
});

describe('finding 6: the host is found through an opening or the decomposition parent; Common sets by supertype', () => {
  it('a door aggregated into an external curtain wall (no opening) is in the façade despite its own IsExternal = false', async () => {
    const facts = await extract((b) => {
      const cw = b.add(`IFCCURTAINWALL(${b.guid()},$,'Glasfassade',$,$,#${b.place(b.storeys.eg.pl, 20, 0, 0)},$,$,.NOTDEFINED.)`);
      b.pset(cw, 'Pset_CurtainWallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
      b.contain(b.storeys.eg.id, cw);
      const door = b.add(`IFCDOOR(${b.guid()},$,'Ladentür',$,$,#${b.place(b.storeys.eg.pl, 20, 5, 0)},#${leafOf(b, 0.1)},$,2.1,1.,.DOOR.,$,$)`);
      b.pset(door, 'Pset_DoorCommon', 'IsExternal', 'IFCBOOLEAN(.F.)');
      b.add(`IFCRELAGGREGATES(${b.guid()},$,$,$,#${cw},(#${door}))`);
    });
    expect(facts.candidates.find((c) => c.name === 'Ladentür')?.selectedBecause).toMatch(/host IsExternal \(Pset_CurtainWallCommon\)/);
  });

  it('a door in an external IfcWallElementedCase reads its host through Pset_WallCommon', async () => {
    const facts = await extract((b) => {
      const wall = b.add(`IFCWALLELEMENTEDCASE(${b.guid()},$,'Holzrahmenwand',$,$,#${b.place(b.storeys.eg.pl, 20, 0, 0)},$,$,.STANDARD.)`);
      b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
      b.contain(b.storeys.eg.id, wall);
      const hole = b.rectExtrusion(0, 0, 1, 2.1, 0.4, b.axis(20.2, 5, 1.05, b.dir(1, 0, 0), b.dir(0, 1, 0)), b.dir(0, 0, -1));
      const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung HRB',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([hole])},$,.OPENING.)`);
      b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
      const door = b.add(`IFCDOOR(${b.guid()},$,'Tür HRB',$,$,#${b.place(b.storeys.eg.pl, 20, 5, 0)},#${leafOf(b, 0.1)},$,2.1,1.,.DOOR.,$,$)`);
      b.pset(door, 'Pset_DoorCommon', 'IsExternal', 'IFCBOOLEAN(.F.)');
      b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${door})`);
      b.contain(b.storeys.eg.id, door);
    });
    expect(facts.candidates.find((c) => c.name === 'Tür HRB')?.selectedBecause).toMatch(/host IsExternal \(Pset_WallCommon\)/);
  });

  it('maps the Common set by supertype (generic since the re-audit: every class of the chain, nearest first)', () => {
    const e = (type: string) => ({ expressId: 1, type, attributes: [] });
    expect(commonPsets(e('IFCWALLELEMENTEDCASE'))).toContain('Pset_WallCommon');
    expect(commonPsets(e('IFCPLATESTANDARDCASE'))).toContain('Pset_PlateCommon');
    expect(commonPsets(e('IFCROOF'))).toContain('Pset_RoofCommon');
    expect(commonPsets(e('IFCCOVERING'))).toContain('Pset_CoveringCommon');
    expect(commonPsets(e('IFCSLABELEMENTEDCASE'))).toContain('Pset_SlabCommon');
    expect(commonPsets(e('IFCBOILER'))[0]).toBe('Pset_BoilerCommon');
  });
});

describe('finding 7: a slab opening is as low as its own readable body', () => {
  it('a sump opening read at -3 m in a slab placed at +4 m is kept, at its body\'s bottom', async () => {
    const facts = await extract((b) => {
      const { ug, og } = b.storeys;
      const slabSolid = b.rectExtrusion(5, 5, 4, 4, 0.3, b.axis(0, 0, -7), b.dir(0, 0, -1));
      const slab = b.add(`IFCSLAB(${b.guid()},$,'Pumpensumpf-Platte',$,$,#${b.place(og.pl, 0, 0, 0)},#${b.shape([slabSolid])},$,.BASESLAB.)`);
      b.contain(ug.id, slab);
      const hole = b.rectExtrusion(5, 5, 0.6, 0.6, 0.3, b.axis(0, 0, -7.3), b.dir(0, 0, 1));
      const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Sumpf',$,$,#${b.place(og.pl, 0, 0, 0)},#${b.shape([hole])},$,.OPENING.)`);
      b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${slab},#${opening})`);
    });
    const sump = facts.candidates.find((c) => c.name === 'Sumpf')!;
    expect(sump).toMatchObject({ category: 'slab-opening', levelBasis: 'opening-body-bottom' });
    expect(sump.level).toBeCloseTo(496.7, 3);
  });
});

describe('finding 8: an opening is bounded only by its own readable body', () => {
  it('an opening with a Brep body, placed at its high window, is kept as an upper estimate', async () => {
    const facts = await extract((b) => {
      const eg = b.storeys.eg;
      const wall = b.add(`IFCWALL(${b.guid()},$,'Wand Ost',$,$,#${b.place(eg.pl, 20, 0, 0)},$,$,.STANDARD.)`);
      b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
      b.contain(eg.id, wall);
      const brep = b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`);
      const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung hoch Brep',$,$,#${b.place(eg.pl, 20, 5, 5.5)},#${b.shape([brep])},$,.OPENING.)`);
      b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
      const win = b.add(`IFCWINDOW(${b.guid()},$,'Oberlicht',$,$,#${b.place(eg.pl, 20, 5, 5.5)},$,$,1.,1.,.WINDOW.,$,$)`);
      b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${win})`);
      b.contain(eg.id, win);
    });
    expect(facts.candidates.find((c) => c.name === 'Öffnung hoch Brep')).toMatchObject({ levelIsUpperEstimate: true });
  });
});

describe('finding 9: an arc\'s lowest point is the circle\'s, not its stored points\'', () => {
  it('a round opening r = 0.5 m centred 1.0 m above the ground storey reaches down to 500.5 m, exactly', async () => {
    const facts = await extract((b) => {
      const eg = b.storeys.eg;
      const wall = b.add(`IFCWALL(${b.guid()},$,'Wand Nord',$,$,#${b.place(eg.pl, 0, 10, 0)},$,$,.STANDARD.)`);
      b.pset(wall, 'Pset_WallCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
      b.contain(eg.id, wall);
      const r = 0.5;
      const at = (a: number) => [r * Math.cos((a * Math.PI) / 180), r * Math.sin((a * Math.PI) / 180)];
      const pts = [at(180), at(200), at(0), at(90)].map(([x, y]) => `(${x.toFixed(6)},${y.toFixed(6)})`).join(',');
      const list = b.add(`IFCCARTESIANPOINTLIST2D((${pts}),$)`);
      const curve = b.add(`IFCINDEXEDPOLYCURVE(#${list},(IFCARCINDEX((1,2,3)),IFCARCINDEX((3,4,1))),.F.)`);
      const prof = b.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#${curve})`);
      const solid = b.add(`IFCEXTRUDEDAREASOLID(#${prof},#${b.axis(5, 10.2, 1.0, b.dir(0, -1, 0), b.dir(1, 0, 0))},#${b.dir(0, 0, 1)},0.4)`);
      const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Bullauge',$,$,#${b.place(eg.pl, 0, 10, 0)},#${b.shape([solid])},$,.OPENING.)`);
      b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
    });
    const c = facts.candidates.find((x) => x.name === 'Bullauge')!;
    expect(c.level).toBeCloseTo(500.5, 4);
    expect(c.levelIsUpperEstimate).toBe(false);
  });
});

describe('the auditor\'s fail-closed suspicions', () => {
  it('a representation context with a shifted WorldCoordinateSystem is refused', async () => {
    const store = await parseStep(syntheticHouse({
      verticalDatum: 'LN02',
      extra: (b) => {
        b.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',2,1.E-05,#${b.axis(100, 0, 0)},$)`);
      },
    }));
    expect(() => extractModelFacts(store, { expectedCrs: 'EPSG:2056' })).toThrow(FloodCheckRefusal);
    try {
      extractModelFacts(store, { expectedCrs: 'EPSG:2056' });
    } catch (e) {
      expect((e as FloodCheckRefusal).code).toBe('world-coordinate-system');
    }
  });

  it('an implausible OverallHeight (0.0021 "m", a millimetre value read as metres) bounds nothing', async () => {
    const facts = await extract((b) => {
      const brep = b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`);
      const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung OG',$,$,#${b.place(b.storeys.og.pl, 20, 5, 0)},#${b.shape([brep])},$,.OPENING.)`);
      const win = b.add(`IFCWINDOW(${b.guid()},$,'Fenster mm',$,$,#${b.place(b.storeys.og.pl, 20, 5, 0)},$,$,0.0021,1.,.WINDOW.,$,$)`);
      b.pset(win, 'Pset_WindowCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
      b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${win})`);
      b.contain(b.storeys.og.id, win);
    });
    // Taken at face value, 2.1 mm would prove the window above the scope (504 m - 0.002 m); implausible, it bounds nothing: kept.
    expect(facts.candidates.find((c) => c.name === 'Fenster mm')).toMatchObject({ levelIsUpperEstimate: true });
  });

  it('a seam between two adjacent slabs is not outline: an element on it is anchored on the real façade', async () => {
    const facts = await extract((b) => {
      const { eg, ug } = b.storeys;
      for (const [x, name] of [[5, 'West'], [15, 'Ost']] as const) {
        b.contain(eg.id, b.add(`IFCSLAB(${b.guid()},$,'Platte ${name}',$,$,#${b.place(eg.pl, 0, 0, 0)},#${b.shape([b.rectExtrusion(x, 2, 10, 4, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1))])},$,.FLOOR.)`));
      }
      b.contain(ug.id, b.add(`IFCBOILER(${b.guid()},$,'Kessel Fuge',$,$,#${b.place(ug.pl, 10, 2, 0)},#${b.shape([b.rectExtrusion(0, 0, 0.5, 0.5, 1, b.axis(0, 0, 0), b.dir(0, 0, 1))])},$,.WATER.)`));
    }, false);
    const r = checkFloodExposure(facts, localRaster(() => CELL_NO_RUNOFF), flatTerrain(499.95), { renderingConfirmation: CONFIRMED, otherBuildings: NO_OTHER_BUILDINGS });
    const boiler = r.results.find((x) => x.candidate.name === 'Kessel Fuge')!;
    expect(boiler.anchorOffset).toBeCloseTo(2, 3);
    expect(localOf(boiler.anchor).x).toBeCloseTo(10, 3);
    expect(boiler.outcome).not.toBe('no-runoff-mapped');
  });

  it('a non-boolean IsExternal reads as unstated', async () => {
    const facts = await extract((b) => {
      const door = b.add(`IFCDOOR(${b.guid()},$,'Tür Text',$,$,#${b.place(b.storeys.eg.pl, 10, 5, 0)},#${leafOf(b)},$,2.1,1.,.DOOR.,$,$)`);
      b.pset(door, 'Pset_DoorCommon', 'IsExternal', "IFCLABEL('true')");
      b.contain(b.storeys.eg.id, door);
    });
    expect(facts.skipped.find((s) => s.ifcClass === 'IfcDoor' && /IsExternal not stated/.test(s.reason))).toBeDefined();
  });
});
