/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { loadEpsgIndex } from './epsg-index.js';
import {
  createEpsgCrsCatalog,
  getEpsgAreaOfUse,
  getEpsgAreasOfUse,
  getEpsgCompoundComponents,
  getEpsgUnit,
  isLonLatInAreaOfUse,
  isLonLatInEpsgAreaOfUse,
} from './epsg-extents.js';

/**
 * Expected values were read from the EPSG Registry API on 2026-11-15, each
 * independent of the generator's code path:
 *   GET https://apps.epsg.org/api/v1/CoordRefSystem/{code}  -> Usage[0].Extent
 *   GET https://apps.epsg.org/api/v1/Extent/{extent code}   -> BoundingBox*
 *   GET https://apps.epsg.org/api/v1/Unit/{unit code}       -> Name, FactorB / FactorC
 * [west, south, east, north] in degrees; unit metres = FactorB / FactorC.
 */
const REGISTRY: Array<[string, [number, number, number, number], string, number | undefined]> = [
  ['2056', [5.95, 45.81, 10.5, 47.81], 'metre', 1], // CH1903+ / LV95, extent 1286
  ['21781', [5.95, 45.81, 10.5, 47.81], 'metre', 1], // CH1903 / LV03, extent 1286
  ['3006', [10.03, 54.96, 24.17, 69.07], 'metre', 1], // SWEREF 99 TM, extent 1225
  ['25832', [6, 36.53, 12.01, 84.01], 'metre', 1], // ETRS89 / UTM 32N, extent 2126
  ['31467', [7.5, 47.27, 10.51, 55.09], 'metre', 1], // DHDN / GK zone 3, extent 1625
  ['28992', [2.53, 50.75, 7.22, 55.77], 'metre', 1], // RD, extent 1172
  ['27700', [-9.01, 49.75, 2.01, 61.01], 'metre', 1], // British National Grid, extent 4390
  ['2227', [-123.18, 36.74, -117.83, 38.72], 'US survey foot', 1200 / 3937], // CA zone 3 (ftUS), extent 2177
  ['4326', [-180, -90, 180, 90], 'degree', undefined], // WGS 84, extent 2830
  ['3857', [-180, -85.06, 180, 85.06], 'metre', 1], // Pseudo-Mercator, extent 3544
  ['3460', [176.81, -20.81, -178.15, -12.42], 'metre', 1], // Fiji Map Grid, extent 1094 (antimeridian)
  ['3832', [98.69, -60, -68, 66.67], 'metre', 1], // PDC Mercator, extent 3172 (antimeridian)
];

describe('EPSG extents sidecar', () => {
  it.each(REGISTRY)('EPSG:%s matches the registry', async (code, box, unitName, metres) => {
    const area = await getEpsgAreaOfUse(code);
    expect(area).toBeDefined();
    expect([area!.west, area!.south, area!.east, area!.north]).toEqual(box);
    expect(area!.crossesAntimeridian).toBe(box[0] > box[2]);

    const unit = await getEpsgUnit(code);
    expect(unit?.name).toBe(unitName);
    if (metres === undefined) expect(unit?.metres).toBeUndefined();
    else expect(unit?.metres).toBeCloseTo(metres, 9);
  });

  it('records compound components and inherits the horizontal unit', async () => {
    // Registry: CompoundCoordRefSystem/5972 -> HorizontalCrs 11022, VerticalCrs 5941
    //           CompoundCoordRefSystem/7415 -> HorizontalCrs 28992, VerticalCrs 5709
    expect(await getEpsgCompoundComponents(5972)).toEqual({ horizontal: '11022', vertical: '5941' });
    expect(await getEpsgCompoundComponents(7415)).toEqual({ horizontal: '28992', vertical: '5709' });
    expect(await getEpsgCompoundComponents(2056)).toBeUndefined();
    expect((await getEpsgUnit(7415))?.metres).toBe(1);
    const area = await getEpsgAreaOfUse(7415);
    expect([area!.west, area!.south, area!.east, area!.north]).toEqual([2.53, 50.75, 7.22, 55.77]);
  });

  it('keeps every current usage; the first is the primary', async () => {
    // Registry: CoordRefSystem/3067 has Usage extents 1095 (Finland) and 4782 (24°E to 30°E);
    // 25832's two usages have different extents with identical boxes, stored once.
    const areas = await getEpsgAreasOfUse(3067);
    expect(areas!.map(a => [a.west, a.south, a.east, a.north])).toEqual([
      [19.08, 58.84, 31.59, 70.09],
      [23.99, 59.64, 30, 70.09],
    ]);
    expect((await getEpsgAreasOfUse(25832))!.length).toBe(1);
  });

  it('returns undefined for unknown codes', async () => {
    expect(await getEpsgAreaOfUse(99999999)).toBeUndefined();
    expect(await getEpsgUnit('nope')).toBeUndefined();
    expect(await isLonLatInEpsgAreaOfUse(99999999, 0, 0)).toBeUndefined();
  });

  it('guards that every projected entry has a plausible box', async () => {
    const entries = await loadEpsgIndex();
    const projected = entries.filter(entry => entry.kind === 'Projected');
    expect(projected.length).toBeGreaterThan(5000);
    const bad: string[] = [];
    for (const entry of projected) {
      const areas = await getEpsgAreasOfUse(entry.code);
      const ok = !!areas && areas.every(a =>
        a.south < a.north &&
        a.south >= -90 && a.north <= 90 &&
        a.west >= -180 && a.west <= 180 && a.east >= -180 && a.east <= 180 &&
        a.west !== a.east,
      );
      if (!ok) bad.push(entry.code);
    }
    expect(bad).toEqual([]);
  });
});

describe('isLonLatInAreaOfUse', () => {
  const lv95 = { west: 5.95, south: 45.81, east: 10.5, north: 47.81 };
  const fiji = { west: 176.81, south: -20.81, east: -178.15, north: -12.42 };

  it('is true inside and false outside, on both sides of every edge', () => {
    expect(isLonLatInAreaOfUse(lv95, 7.44, 46.95)).toBe(true); // Bern
    expect(isLonLatInAreaOfUse(lv95, 10.5, 47.81)).toBe(true); // corner is inside
    expect(isLonLatInAreaOfUse(lv95, 10.51, 46.5)).toBe(false);
    expect(isLonLatInAreaOfUse(lv95, 5.94, 46.5)).toBe(false);
    expect(isLonLatInAreaOfUse(lv95, 8, 47.82)).toBe(false);
    expect(isLonLatInAreaOfUse(lv95, 8, 45.80)).toBe(false);
    expect(isLonLatInAreaOfUse(lv95, 2.3, 48.85)).toBe(false); // Paris
  });

  it('applies a margin on every side', () => {
    expect(isLonLatInAreaOfUse(lv95, 10.9, 46.5, 0.5)).toBe(true);
    expect(isLonLatInAreaOfUse(lv95, 11.1, 46.5, 0.5)).toBe(false);
    expect(isLonLatInAreaOfUse(lv95, 5.5, 46.5, 0.5)).toBe(true);
    expect(isLonLatInAreaOfUse(lv95, 8, 48.2, 0.5)).toBe(true);
    expect(isLonLatInAreaOfUse(lv95, 8, 48.4, 0.5)).toBe(false);
  });

  it('handles boxes that cross the antimeridian', () => {
    expect(isLonLatInAreaOfUse(fiji, 178, -17.7)).toBe(true); // Suva side
    expect(isLonLatInAreaOfUse(fiji, -179, -16.5)).toBe(true); // Taveuni side
    expect(isLonLatInAreaOfUse(fiji, 180, -17)).toBe(true);
    expect(isLonLatInAreaOfUse(fiji, -180, -17)).toBe(true);
    expect(isLonLatInAreaOfUse(fiji, 176.8, -17)).toBe(false);
    expect(isLonLatInAreaOfUse(fiji, -178.1, -17)).toBe(false);
    expect(isLonLatInAreaOfUse(fiji, 0, -17)).toBe(false);
    // margin reaches across the date line from either side
    expect(isLonLatInAreaOfUse(fiji, 176.5, -17, 0.5)).toBe(true);
    expect(isLonLatInAreaOfUse(fiji, -177.8, -17, 0.5)).toBe(true);
    expect(isLonLatInAreaOfUse(fiji, -177.5, -17, 0.5)).toBe(false);
  });

  it('treats a world box as everywhere and rejects non-finite input', () => {
    const world = { west: -180, south: -90, east: 180, north: 90 };
    expect(isLonLatInAreaOfUse(world, 123, -45)).toBe(true);
    expect(isLonLatInAreaOfUse(world, Number.NaN, 0)).toBe(false);
  });

  it('answers per code through the bundled data', async () => {
    expect(await isLonLatInEpsgAreaOfUse(2056, 7.44, 46.95)).toBe(true);
    expect(await isLonLatInEpsgAreaOfUse(2056, 2.3, 48.85)).toBe(false);
    expect(await isLonLatInEpsgAreaOfUse(3460, -179, -16.5)).toBe(true);
    expect(await isLonLatInEpsgAreaOfUse(3460, 0, -16.5)).toBe(false);
    expect(await isLonLatInEpsgAreaOfUse(2056, 10.9, 46.5, 0.5)).toBe(true);
  });
});

describe('createEpsgCrsCatalog', () => {
  it('looks up kind, area of use and unit scale', async () => {
    const catalog = await createEpsgCrsCatalog();
    expect(catalog.lookup(2056)).toEqual({
      code: 2056,
      kind: 'projected',
      areaOfUse: { west: 5.95, south: 45.81, east: 10.5, north: 47.81 },
      unitScale: 1,
    });
    expect(catalog.lookup(2227)?.unitScale).toBeCloseTo(1200 / 3937, 9);
    const wgs84 = catalog.lookup(4326);
    expect(wgs84?.kind).toBe('geographic');
    expect(wgs84?.unitScale).toBeUndefined();
    expect(catalog.lookup(7415)?.kind).toBe('compound');
    expect(catalog.lookup(5709)?.kind).toBe('vertical');
    expect(catalog.lookup(3460)?.areaOfUse?.west).toBeGreaterThan(catalog.lookup(3460)!.areaOfUse!.east);
    expect(catalog.lookup(99999999)).toBeUndefined();
  });

  it('resolves the name forms the index knows', async () => {
    const catalog = await createEpsgCrsCatalog();
    expect(catalog.resolveName('CH1903+ / LV95')).toBe(2056);
    expect(catalog.resolveName('  ch1903+  /  lv95 ')).toBe(2056);
    expect(catalog.resolveName('EPSG:21781')).toBe(21781);
    expect(catalog.resolveName('28992')).toBe(28992);
    expect(catalog.resolveName('LV95')).toBe(2056); // EPSG abbreviation alias
    expect(catalog.resolveName('EPSG:99999999')).toBeUndefined();
    expect(catalog.resolveName('no such crs')).toBeUndefined();
  });
});
