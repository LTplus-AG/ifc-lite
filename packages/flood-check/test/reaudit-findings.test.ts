/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The re-audit of the side branch at cd091e097f (N1–N8 and the suspicion
 * about the checked building's own pixels), each as the auditor's
 * reproduction asserting the fixed behaviour.
 */

import { describe, expect, it } from 'vitest';
import { BAFU_CLASSES } from '../src/bafu/dataset.js';
import { checkFloodExposure } from '../src/check/check.js';
import { normalizeCrs } from '../src/crs.js';
import { FloodCheckRefusal } from '../src/errors.js';
import { prepareFootprint } from '../src/region.js';
import { extractModelFacts } from '../src/model/extract.js';
import type { CandidateFact, FootprintFact } from '../src/model/facts.js';
import { toPropertySets } from '../src/psets.js';
import { CELL_NO_RUNOFF, type MapPoint, type OtherBuildingFootprints } from '../src/types.js';
import { boxFacts, candidate, CODE, CONFIRMED, E0, flatTerrain, N0, NO_OTHER_BUILDINGS, syntheticRaster } from './helpers.js';
import { raster as localRaster } from './candidate-fixtures.js';
import { parseStep, syntheticHouse, type Extra, type SyntheticOptions } from './synthetic-model.js';

const P = (x: number, y: number): MapPoint => ({ x: E0 + x, y: N0 + y });
const deep = CODE['depth-gt-0.25'];
const opts = { renderingConfirmation: CONFIRMED, otherBuildings: NO_OTHER_BUILDINGS };
const ras = (paint: (p: MapPoint) => number) => syntheticRaster(E0 - 10, N0 - 10, 80, 60, 0.5, paint);
const footprint = (rings: MapPoint[][], source: FootprintFact['source'] = 'slab-outline'): FootprintFact => ({ rings, source, fromElements: [] });
const extract = async (extra: (b: Extra) => void, o: SyntheticOptions = {}) =>
  extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', ...o, extra })), { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });
const leafOf = (b: Extra) => b.shape([b.rectExtrusion(0, 0, 1, 0.1, 2.1, b.axis(0, 0, 0), b.dir(0, 0, 1))]);
const boiler = (at: MapPoint): CandidateFact =>
  candidate({ expressId: 2, name: 'Kessel', ifcClass: 'IfcBoiler', predefinedType: 'WATER', category: 'equipment', position: at, level: 500 });

describe('N1: a position in a gap between footprint slabs is inside the building', () => {
  const run = (gap: number) => {
    const A = [P(0, 0), P(10, 0), P(10, 10), P(0, 10)];
    const B = [P(10 + gap, 0), P(20, 0), P(20, 10), P(10 + gap, 10)];
    const facts = boxFacts([candidate({ expressId: 1, position: P(5, 0), level: 500 }), boiler(P(10 + gap / 2, 1.5))], { footprint: footprint([A, B]) });
    return checkFloodExposure(facts, ras(() => CELL_NO_RUNOFF), flatTerrain(499.95), opts).results[1];
  };

  it.each([0, 0.0005, 0.002, 0.01, 0.05, 0.2, 0.6])('repro F, gap %s m: the boiler is anchored on the real façade 1.5 m away (anchor-moved)', (gap) => {
    const r = run(gap);
    expect(r.anchorOffset).toBeCloseTo(1.5, 1); // to the façade below, or its corner when the gap is wider
    expect(r).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'anchor-moved' });
  });

  it('control: a real passage 1.2 m wide stays open ground, so the boiler in it is anchored on itself', () => {
    expect(run(1.2)).toMatchObject({ anchorBasis: 'element', anchorOffset: 0 });
  });

  it('repro G: a pass-through over a 0.2 m slab gap under an interior wall is interior, and the gap is noted on the footprint', async () => {
    const facts = await extract((b) => {
      const { eg } = b.storeys;
      for (const [x, name] of [[4.95, 'West'], [15.05, 'Ost']] as const) {
        b.contain(eg.id, b.add(`IFCSLAB(${b.guid()},$,'Raum ${name}',$,$,#${b.place(eg.pl, 0, 0, 0)},#${b.shape([b.rectExtrusion(x, 5, 9.9, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1))])},$,.FLOOR.)`));
      }
      const wall = b.add(`IFCWALL(${b.guid()},$,'Innenwand',$,$,#${b.place(eg.pl, 10, 0, 0)},$,$,.STANDARD.)`);
      b.contain(eg.id, wall);
      const hole = b.rectExtrusion(0, 0, 0.4, 1, 0.6, b.axis(0, 0, 0), b.dir(0, 0, 1));
      const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Durchreiche',$,$,#${b.place(eg.pl, 9.9, 1.5, 0.8)},#${b.shape([hole])},$,.OPENING.)`);
      b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${wall},#${opening})`);
    }, { slab: false });
    expect(facts.footprint.quality?.notes.join()).toMatch(/gap between footprint rings/);
    expect(facts.candidates.map((c) => c.name)).not.toContain('Durchreiche');
    expect(facts.skipped.find((s) => s.ifcClass === 'IfcOpeningElement' && /not in the façade/.test(s.reason))).toBeDefined();
  });
});

describe('N2: a ground storey picked by the ±0.00 convention does not confirm the height reference', () => {
  it('repro R1: storeys UG 0 / EG +3 / OG +7, the basement picked: unconfirmed, and nothing is above the mapped range', async () => {
    const text = syntheticHouse({
      verticalDatum: 'LN02',
      storeyZ: { ug: 0, eg: 3, og: 7 },
      extra: (b) => {
        for (const [storey, x, name] of [[b.storeys.ug, 4, 'UG Tür'], [b.storeys.eg, 16, 'EG Seitentür']] as const) {
          const door = b.add(`IFCDOOR(${b.guid()},$,'${name}',$,$,#${b.place(storey.pl, x, 0, 0)},#${leafOf(b)},$,2.1,1.,.DOOR.,$,$)`);
          b.pset(door, 'Pset_DoorCommon', 'IsExternal', 'IFCBOOLEAN(.T.)');
          b.contain(storey.id, door);
        }
      },
    });
    const facts = extractModelFacts(await parseStep(text), { expectedCrs: 'EPSG:2056' });
    expect(facts.groundStorey.basis).toBe('project-zero');
    expect(facts.warnings.join()).toMatch(/pass groundStorey/);
    const r = checkFloodExposure(facts, localRaster(() => CODE['depth-0.1-0.25']), flatTerrain(500), opts);
    expect(r.heightReference.status).toBe('unconfirmed');
    expect(r.heightReference.unconfirmedBecause.join()).toMatch(/guessed \(project-zero\)/);
    expect(r.results.map((x) => x.outcome)).not.toContain('above-mapped-class-range');
  });
});

describe('N3: the courtyard guard tests the ring the anchor was taken on; a slab spanning a notch is no courtyard', () => {
  const A = [P(0, 0), P(10, 0), P(10, 12), P(0, 12)];
  const B = [P(10, 0), P(20, 0), P(20, 12), P(10, 12)];
  const C = [P(10.15, 1), P(14, 1), P(14, 6), P(10.15, 6)];
  const inC = (p: MapPoint) => p.x > E0 + 10.15 && p.x < E0 + 14 && p.y > N0 + 1 && p.y < N0 + 6;
  // A courtyard exists only in a given footprint (slab rings are material), and is open ground (automated review of 0b30b84):
  // the deep class in it is sampled. Transparent, the courtyard guard withholds.
  const run = (at: MapPoint, paint: (p: MapPoint) => number = (p) => (inC(p) ? deep : CELL_NO_RUNOFF)) =>
    checkFloodExposure(boxFacts([candidate({ position: at, level: 500 })], { footprint: footprint([A, B, C], 'given') }), ras(paint), flatTerrain(499.95), opts).results[0];

  it('repro C1: a door on the seam 0.15 m from the courtyard is anchored on the courtyard: exposed by its deep class, withheld when it is clear', () => {
    expect(run(P(10, 1.5))).toMatchObject({ outcome: 'exposed', anchorOffset: expect.closeTo(0.15, 3) });
    expect(run(P(10, 1.5), () => CELL_NO_RUNOFF)).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'courtyard-ring' });
  });
  it('control: the door on the courtyard edge itself', () => {
    expect(run(P(10.15, 1.5)).outcome).toBe('exposed');
    expect(run(P(10.15, 1.5), () => CELL_NO_RUNOFF)).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'courtyard-ring' });
  });

  it('a slab whose vertices lie in two others but whose edge crosses the notch between them keeps its exposure flag', () => {
    const tall = [P(0, 0), P(10, 0), P(10, 20), P(0, 20)];
    const top = [P(0, 10), P(20, 10), P(20, 20), P(0, 20)];
    const D = [P(8, 2), P(9, 2), P(18, 18), P(8, 18)];
    expect(prepareFootprint({ rings: [tall, top, D], source: 'given' }).courtyards.has(2)).toBe(false);
    const inside = (p: MapPoint) => [tall, top, D].some((r) => p.x >= r[0].x && p.x <= r[1].x && p.y >= r[0].y && p.y <= r[2].y && r !== D);
    const door = candidate({ position: P(12.6, 8.4), level: 500 });
    const r = checkFloodExposure(boxFacts([door], { footprint: footprint([tall, top, D]) }), ras((p) => (inside(p) ? CELL_NO_RUNOFF : deep)), flatTerrain(499.95), opts);
    expect(['exposed', 'open-ended-class']).toContain(r.results[0].outcome);
  });
});

describe('N4: other buildings\' rings are validated, and complete holds only inside the stated extent', () => {
  const garage = [P(5, -6), P(15, -6), P(15, 0), P(5, 0)];
  const inGarage = (p: MapPoint) => p.x > E0 + 5 && p.x < E0 + 15 && p.y > N0 - 6 && p.y < N0;
  const inHouse = (p: MapPoint) => p.x > E0 && p.x < E0 + 20 && p.y > N0 && p.y < N0 + 10;
  const run = (o: OtherBuildingFootprints) =>
    checkFloodExposure(boxFacts([candidate({ position: P(10, 0), level: 500 })]), ras((p) => (inGarage(p) || inHouse(p) ? CELL_NO_RUNOFF : deep)), flatTerrain(499.95), {
      renderingConfirmation: CONFIRMED,
      otherBuildings: o,
    });
  const src = (rings: MapPoint[][]): OtherBuildingFootprints => ({ ...NO_OTHER_BUILDINGS, rings });

  it('repro R2, the correct ring: other-building', () => {
    expect(run(src([garage])).results[0].unclassifiedReason).toBe('other-building');
  });
  it.each([
    ['x and y swapped', [garage.map((p) => ({ x: p.y, y: p.x }))]],
    ['a two-point ring', [garage.slice(0, 2)]],
    ['the ring listed twice', [[...garage, ...garage]]],
  ])('repro R2, %s: the source is not complete, so not "no runoff mapped"', (_label, rings) => {
    const r = run(src(rings as MapPoint[][]));
    expect(r.results[0]).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'other-buildings-unknown' });
    expect(r.otherBuildings).toMatchObject({ supplied: true, complete: false });
    expect(r.otherBuildings.rejected.join()).toMatch(/ring 0/);
  });
  it('a transparent sample outside the stated extent is unknown; zero rings with a covering extent is open country', () => {
    const tiny = { ...NO_OTHER_BUILDINGS, extent: { minX: E0, minY: N0, maxX: E0 + 20, maxY: N0 + 10 } };
    const open = checkFloodExposure(boxFacts([candidate({ position: P(10, 0), level: 500 })]), ras(() => CELL_NO_RUNOFF), flatTerrain(499.95), { renderingConfirmation: CONFIRMED, otherBuildings: tiny });
    expect(open.results[0].unclassifiedReason).toBe('other-buildings-unknown');
    const country = checkFloodExposure(boxFacts([candidate({ position: P(10, 0), level: 500 })]), ras(() => CELL_NO_RUNOFF), flatTerrain(499.95), opts);
    expect(country.results[0].outcome).toBe('no-runoff-mapped');
  });
});

describe('N5: a host\'s IsExternal is read from the Common set of whatever class it is', () => {
  const doorIn = (hostRecord: (pl: number) => string, psetName: string) => async () => {
    const facts = await extract((b) => {
      const eg = b.storeys.eg;
      const host = b.add(hostRecord(b.place(eg.pl, 0, 0, 0)));
      b.pset(host, psetName, 'IsExternal', 'IFCBOOLEAN(.T.)');
      b.contain(eg.id, host);
      const hole = b.rectExtrusion(0, 0, 1, 2.1, 0.4, b.axis(10, 9.8, 1.05, b.dir(0, 1, 0), b.dir(1, 0, 0)), b.dir(0, 0, 1));
      const opening = b.add(`IFCOPENINGELEMENT(${b.guid()},$,'Öffnung',$,$,#${b.place(eg.pl, 0, 0, 0)},#${b.shape([hole])},$,.OPENING.)`);
      b.add(`IFCRELVOIDSELEMENT(${b.guid()},$,$,$,#${host},#${opening})`);
      const door = b.add(`IFCDOOR(${b.guid()},$,'Tür Nord',$,$,#${b.place(eg.pl, 10, 10, 0)},#${leafOf(b)},$,2.1,1.,.DOOR.,$,$)`);
      b.pset(door, 'Pset_DoorCommon', 'IsExternal', 'IFCBOOLEAN(.F.)');
      b.add(`IFCRELFILLSELEMENT(${b.guid()},$,$,$,#${opening},#${door})`);
      b.contain(eg.id, door);
    });
    expect(facts.candidates.find((c) => c.name === 'Tür Nord')?.selectedBecause).toMatch(new RegExp(`host IsExternal \\(${psetName}\\)`));
  };
  it('repro B1: a building element proxy host', doorIn((pl) => `IFCBUILDINGELEMENTPROXY('3proxyGuid000000000001',$,'Proxy Fassade',$,$,#${pl},$,$,.ELEMENT.)`, 'Pset_BuildingElementProxyCommon'));
  it('repro B1: a member host', doorIn((pl) => `IFCMEMBER('3memberGuid00000000001',$,'Pfosten',$,$,#${pl},$,$,.MULLION.)`, 'Pset_MemberCommon'));
});

describe('N6, N7: CRS URIs and the WorldCoordinateSystem tolerance', () => {
  it('N6: normalizeCrs accepts the OGC URI form, http and https', () => {
    expect(normalizeCrs('http://www.opengis.net/def/crs/EPSG/0/2056')).toBe('EPSG:2056');
    expect(normalizeCrs('https://www.opengis.net/def/crs/EPSG/0/5728')).toBe('EPSG:5728');
  });

  const wcs = (x: number, dirY: number) => (b: Extra) => {
    const pt = b.add(`IFCCARTESIANPOINT((${x},0.,0.))`);
    const ref = b.add(`IFCDIRECTION((1.,${dirY},0.))`);
    b.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',2,1.E-05,#${b.add(`IFCAXIS2PLACEMENT3D(#${pt},$,#${ref})`)},$)`);
  };
  const mm = async (x: number, dirY: number) =>
    extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', lengthUnit: 'MILLIMETRE', scale: 0.001, extra: wcs(x, dirY) })), { expectedCrs: 'EPSG:2056' });

  it('N7: an origin 0.0005 mm off and a direction 1e-8 off are the identity', async () => {
    await expect(mm(0.0005, 1e-8)).resolves.toBeDefined();
  });
  it('N7 control: an origin 1 mm off is still refused', async () => {
    await expect(mm(1, 0)).rejects.toBeInstanceOf(FloodCheckRefusal);
  });
});

describe('N8: the skipped counts add up', () => {
  it('ElementsSkippedByReason sums to CountElementsSkipped; an unreadable footprint slab has its own field', async () => {
    const facts = await extract((b) => {
      const slab = b.add(`IFCSLAB(${b.guid()},$,'Bodenplatte Anbau',$,$,#${b.place(b.storeys.eg.pl, 20, 0, 0)},#${b.shape([b.add(`IFCFACETEDBREP(#${b.add('IFCCLOSEDSHELL(())')})`)], 'Body', 'Brep')},$,.FLOOR.)`);
      b.contain(b.storeys.eg.id, slab);
    });
    const r = checkFloodExposure(facts, localRaster(() => CELL_NO_RUNOFF), flatTerrain(499.95), opts);
    const site = Object.fromEntries(toPropertySets(r, BAFU_CLASSES).site.Properties.map((p) => [p.Name, p.NominalValue]));
    const sum = String(site.ElementsSkippedByReason).split(' | ').filter(Boolean).reduce((n, part) => n + Number(part.split('×')[0]), 0);
    expect(sum).toBe(site.CountElementsSkipped);
    expect(site.CountFootprintSourcesNotRead).toBe(1);
    expect(site.FootprintSourcesNotRead).toMatch(/IfcSlab #\d+/);
  });
});

describe('the auditor\'s suspicion: the checked building\'s own pixels beyond a footprint up to 1 m too small', () => {
  // The hazard model raised the real building, 1 m larger on every side than the model's footprint (0..20 x 0..10).
  const real = (p: MapPoint) => p.x > E0 - 1 && p.x < E0 + 21 && p.y > N0 - 1 && p.y < N0 + 11;
  const near = (p: MapPoint, w: number) => !real(p) && p.x > E0 - 1 - w && p.x < E0 + 21 + w && p.y > N0 - 1 - w && p.y < N0 + 11 + w;
  it.each([
    ['a deep class everywhere around the real building', (p: MapPoint) => (real(p) ? CELL_NO_RUNOFF : deep)],
    ['a deep class only in a 1 m band along the real façade', (p: MapPoint) => (near(p, 1) ? deep : CELL_NO_RUNOFF)],
  ])('%s: the door is not reported as no runoff mapped', (_l, paint) => {
    const r = checkFloodExposure(boxFacts([candidate({ position: P(10, 0), level: 500 })]), ras(paint), flatTerrain(499.95), opts);
    expect(r.results[0].outcome).not.toBe('no-runoff-mapped');
  });
});

describe('CodeRabbit: a sample on another building\'s boundary is inside it', () => {
  it('a transparent sample on the north edge of another building counts as other-building, not open ground', () => {
    // The door's 3 m sample due south lands exactly on the shed's north edge (y = -3).
    const shed = [P(9.75, -4), P(10.25, -4), P(10.25, -3), P(9.75, -3)];
    const r = checkFloodExposure(boxFacts([candidate({ position: P(10, 0), level: 500 })]), ras(() => CELL_NO_RUNOFF), flatTerrain(499.95), {
      renderingConfirmation: CONFIRMED,
      otherBuildings: { ...NO_OTHER_BUILDINGS, rings: [shed] },
    });
    expect(r.results[0]).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'other-building' });
  });
});

describe('the automated review of 0b30b84, check side', () => {
  it('an uncertain position (positionIsUncertain) never gets a favourable outcome, even with an exact level', () => {
    // An exact door elsewhere confirms the height reference (an uncertain door no longer may: review of a46ce9cb0).
    const front = candidate({ expressId: 7, position: P(5, 10), level: 500 });
    const r = checkFloodExposure(boxFacts([candidate({ position: P(10, 0), level: 500, positionIsUncertain: true }), front]), ras(() => CELL_NO_RUNOFF), flatTerrain(499.95), opts);
    expect(r.results[0]).toMatchObject({ outcome: 'unclassified', unclassifiedReason: 'position-uncertain' });
    const control = checkFloodExposure(boxFacts([candidate({ position: P(10, 0), level: 500 })]), ras(() => CELL_NO_RUNOFF), flatTerrain(499.95), opts);
    expect(control.results[0].outcome).toBe('no-runoff-mapped');
  });

  it('a given courtyard is open ground for sampling too: a deep class in it makes the courtyard door exposed', () => {
    const outer = [P(0, 0), P(30, 0), P(30, 30), P(0, 30)];
    const court = [P(5, 5), P(25, 5), P(25, 25), P(5, 25)];
    const inCourt = (p: MapPoint) => p.x > E0 + 5 && p.x < E0 + 25 && p.y > N0 + 5 && p.y < N0 + 25;
    const facts = boxFacts([candidate({ position: P(15, 5), level: 500 })], { footprint: footprint([outer, court], 'given') });
    const r = checkFloodExposure(facts, syntheticRaster(E0 - 10, N0 - 10, 100, 100, 0.5, (p) => (inCourt(p) ? deep : CELL_NO_RUNOFF)), flatTerrain(499.95), opts);
    expect(r.results[0].outcome).toBe('exposed');
  });
});

describe('the automated review of a46ce9cb0, check side: only exact, certain door levels confirm the height reference', () => {
  it.each([
    ['a lower-bound level (read from a clipped body)', { levelIsLowerBound: true }],
    ['an uncertain position', { positionIsUncertain: true }],
  ])('a ground-storey door with %s does not confirm it', (_l, over) => {
    const door = candidate({ position: P(10, 0), level: 500, storeyId: 10, ...over });
    const r = checkFloodExposure(boxFacts([door]), ras(() => CELL_NO_RUNOFF), flatTerrain(499.95), opts);
    expect(r.heightReference.status).toBe('unconfirmed');
    const control = checkFloodExposure(boxFacts([candidate({ position: P(10, 0), level: 500, storeyId: 10 })]), ras(() => CELL_NO_RUNOFF), flatTerrain(499.95), opts);
    expect(control.heightReference.status).toBe('confirmed');
  });
});
