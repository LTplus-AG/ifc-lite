/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { FloodCheckRefusal } from '../src/errors.js';
import { extractModelFacts } from '../src/model/extract.js';
import { mapOf, parseStep, syntheticHouse } from './synthetic-model.js';

async function facts(options: Parameters<typeof syntheticHouse>[0] = {}, extract: Parameters<typeof extractModelFacts>[1] = {}) {
  return extractModelFacts(await parseStep(syntheticHouse(options)), extract);
}

async function refusal(promise: Promise<unknown>): Promise<FloodCheckRefusal> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof FloodCheckRefusal) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('extractModelFacts on a synthetic EPSG:2056 house', () => {
  it('reads the georeference, storeys, ground storey and slab footprint in map coordinates', async () => {
    const f = await facts();
    expect(f.georeference).toMatchObject({ crs: 'EPSG:2056', verticalDatum: null, scaleBasis: 'units-agree', orthogonalHeight: 500 });
    expect(f.georeference.rotationDegrees).toBeCloseTo(30, 9);
    expect(f.storeys.map((s) => [s.name, s.level])).toEqual([['UG', 497], ['EG', 500], ['OG', 504]]);
    expect(f.groundStorey).toMatchObject({ level: 500, basis: 'project-zero' });
    expect(f.footprint.source).toBe('slab-outline');
    const corners = f.footprint.rings[0];
    expect(corners).toHaveLength(4);
    for (const [x, y] of [[0, 0], [20, 0], [20, 10], [0, 10]]) {
      const want = mapOf(x, y);
      expect(corners.some((c) => Math.hypot(c.x - want.x, c.y - want.y) < 1e-6)).toBe(true);
    }
  });

  it('picks one element of every candidate kind, at the right place and level', async () => {
    const f = await facts();
    const byName = Object.fromEntries(f.candidates.map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(
      ['Haustür', 'Hauptverteilung', 'Heizkessel', 'Kellerfenster', 'Kellertreppe aussen', 'Lichtschacht 1', 'Lüftung'].sort(),
    );
    const near = (c: { position: { x: number; y: number } }, x: number, y: number) => {
      const want = mapOf(x, y);
      expect(c.position.x).toBeCloseTo(want.x, 6);
      expect(c.position.y).toBeCloseTo(want.y, 6);
    };
    // Door: host wall external wins over the door's own IsExternal = false.
    expect(byName['Haustür']).toMatchObject({ category: 'door', ifcClass: 'IfcDoor', level: 500, predefinedType: 'DOOR' });
    expect(byName['Haustür'].selectedBecause).toMatch(/host IsExternal.*states IsExternal = false/);
    near(byName['Haustür'], 10, 0);
    // Unfilled opening: placed at the wall origin, hole read from its extrusion.
    expect(byName['Lüftung']).toMatchObject({ category: 'wall-opening', levelBasis: 'opening-body-bottom' });
    expect(byName['Lüftung'].level).toBeCloseTo(500.3, 9);
    near(byName['Lüftung'], 15, 0);
    expect(byName['Kellerfenster']).toMatchObject({ category: 'basement-window', level: 499 });
    expect(byName['Lichtschacht 1']).toMatchObject({ category: 'light-well', ifcClass: 'IfcBuildingElementProxy' });
    expect(byName['Lichtschacht 1'].level).toBeCloseTo(498.8, 9);
    expect(byName['Heizkessel']).toMatchObject({ category: 'equipment', ifcClass: 'IfcBoiler', predefinedType: 'WATER', level: 497 });
    expect(byName['Hauptverteilung']).toMatchObject({ category: 'equipment', ifcClass: 'IfcElectricDistributionBoard', level: 500 });
    // External stair: no top edge readable, so the ground storey level, flagged as an upper estimate.
    expect(byName['Kellertreppe aussen']).toMatchObject({
      category: 'stair',
      level: 500,
      levelBasis: 'ground-storey-level',
      levelIsUpperEstimate: true,
    });
    // Not picked: the interior stair, the pump upstairs, the upper-floor door.
    expect(f.spaces).toMatchObject([{ name: 'Keller', floorLevel: 497 }]);
  });

  it('honours a given ground storey and footprint', async () => {
    const ring = [mapOf(-1, -1), mapOf(21, -1), mapOf(21, 11), mapOf(-1, 11)];
    const f = await facts({}, { groundStorey: 'UG', footprint: [ring] });
    expect(f.groundStorey).toMatchObject({ level: 497, basis: 'given' });
    expect(f.footprint).toMatchObject({ source: 'given', rings: [ring] });
  });

  it('records a stated vertical datum for the check to compare', async () => {
    expect((await facts({ verticalDatum: 'LN02' })).georeference.verticalDatum).toBe('LN02');
  });
});

describe('refusals', () => {
  it('refuses a model without a map conversion', async () => {
    expect((await refusal(facts({ withMapConversion: false }))).code).toBe('not-georeferenced');
  });

  it('refuses a model in another CRS than required, and an unidentifiable CRS', async () => {
    expect((await refusal(facts({ crsName: 'EPSG:21781' }, { expectedCrs: 'EPSG:2056' }))).code).toBe('crs-mismatch');
    expect((await refusal(facts({ crsName: 'Lokales System', crsDescription: 'Baustellenkoordinaten' }))).code).toBe('crs-unrecognised');
    // A name that is no EPSG code is still identified when the description names the CRS unambiguously.
    expect((await facts({ crsName: 'Landeskoordinaten' })).georeference.crs).toBe('EPSG:2056');
  });

  it('refuses an ambiguous Scale and accepts an explicit reading', async () => {
    expect((await refusal(facts({ lengthUnit: 'MILLIMETRE' }))).code).toBe('ambiguous-map-scale');
    const bridged = await facts({ lengthUnit: 'MILLIMETRE' }, { mapScale: 'unit-bridged' });
    expect(bridged.georeference.scaleBasis).toBe('unit-bridged');
    const door = bridged.candidates.find((c) => c.name === 'Haustür')!;
    expect(door.position.x).toBeCloseTo(mapOf(10, 0).x, 6);
    expect(door.level).toBeCloseTo(500, 9);
    // Spec-conformant file: Scale 0.001 bridges mm to the metre map unit.
    const explicit = await facts({ lengthUnit: 'MILLIMETRE', scale: 0.001 });
    expect(explicit.georeference.scaleBasis).toBe('explicit-scale');
    expect(explicit.candidates.find((c) => c.name === 'Haustür')!.position.y).toBeCloseTo(mapOf(10, 0).y, 6);
  });
});
