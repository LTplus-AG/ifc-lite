/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEpsgIndex, loadEpsgIndexDatasetVersion } from './epsg-index.js';
import {
  createEpsgCrsCatalog,
  getEpsgAreaOfUse,
  getEpsgAreasOfUse,
  getEpsgCompoundComponents,
  getEpsgUnits,
  isLonLatInAreaOfUse,
  isLonLatInEpsgAreaOfUse,
  loadEpsgExtentsDatasetVersion,
} from './epsg-extents.js';
import { EPSG_EXTENTS_DATASET_VERSION } from './generated/epsg-extents.generated.js';

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

    const unit = (await getEpsgUnits(code))?.horizontal;
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
    expect((await getEpsgUnits(7415))?.horizontal?.metres).toBe(1);
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
    expect(await getEpsgUnits('nope')).toBeUndefined();
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

  it('reduces a longitude beyond one revolution, keeping box edges exact', () => {
    const lv95 = { west: 5.95, south: 45.81, east: 10.5, north: 47.81 };
    expect(isLonLatInAreaOfUse(lv95, 727.44, 46.95)).toBe(true);
    expect(isLonLatInAreaOfUse(lv95, -712.56, 46.95)).toBe(true);
    expect(isLonLatInAreaOfUse(lv95, 7.44 + 3600, 46.95)).toBe(true);
    expect(isLonLatInAreaOfUse(lv95, 2.3 + 720, 46.95)).toBe(false);
    expect(isLonLatInAreaOfUse(lv95, 10.5, 46.95)).toBe(true);
    expect(isLonLatInAreaOfUse(lv95, 10.51, 46.95)).toBe(false);
    expect(isLonLatInAreaOfUse(fiji, -179 + 720, -16.5)).toBe(true);
    expect(isLonLatInAreaOfUse(fiji, 0 - 720, -16.5)).toBe(false);
    // A negative longitude whose equivalent sits two revolutions up: box 170..10 spans 170..370.
    const wide = { west: 170, south: -10, east: 10, north: 10 };
    for (const lon of [5, -355, -715, 365, 725, 175, -185, -545]) expect(isLonLatInAreaOfUse(wide, lon, 0), String(lon)).toBe(true);
    for (const lon of [100, -260, -620, 460, 20, -340]) expect(isLonLatInAreaOfUse(wide, lon, 0), String(lon)).toBe(false);
    expect(isLonLatInAreaOfUse(wide, -355, 0, 0)).toBe(true);
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

describe('inherited property names are not codes', () => {
  it('returns undefined instead of throwing for Object.prototype keys', async () => {
    for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(await getEpsgAreasOfUse(name), name).toBeUndefined();
      expect(await getEpsgAreaOfUse(name), name).toBeUndefined();
      expect(await getEpsgUnits(name), name).toBeUndefined();
      expect(await getEpsgCompoundComponents(name), name).toBeUndefined();
      expect(await isLonLatInEpsgAreaOfUse(name, 7.44, 46.95), name).toBeUndefined();
    }
  });
});

describe('helper edge cases', () => {
  const lv95 = { west: 5.95, south: 45.81, east: 10.5, north: 47.81 };
  const arctic = { west: -180, south: 80, east: 180, north: 90 };

  it('rejects latitudes beyond a pole and non-finite input even with a margin', () => {
    expect(isLonLatInAreaOfUse(arctic, 0, 91, 5)).toBe(false);
    expect(isLonLatInAreaOfUse(arctic, 0, -91, 100)).toBe(false);
    expect(isLonLatInAreaOfUse(arctic, 0, 90)).toBe(true);
    expect(isLonLatInAreaOfUse(lv95, Number.POSITIVE_INFINITY, 46.5, 5)).toBe(false);
    expect(isLonLatInAreaOfUse(lv95, 8, Number.NaN, 5)).toBe(false);
  });

  it('throws on a negative or non-finite margin instead of clamping', () => {
    expect(() => isLonLatInAreaOfUse(lv95, 8, 46.5, -1)).toThrow(RangeError);
    expect(() => isLonLatInAreaOfUse(lv95, 8, 46.5, Number.NaN)).toThrow(RangeError);
    expect(() => isLonLatInAreaOfUse(lv95, 8, 46.5, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('rejects a negative margin through the per-code helper', async () => {
    await expect(isLonLatInEpsgAreaOfUse(2056, 7.44, 46.95, -0.5)).rejects.toThrow(RangeError);
    // An invalid margin is an error even when the code is unknown, never `undefined`.
    await expect(isLonLatInEpsgAreaOfUse(99999999, 0, 0, -1)).rejects.toThrow(RangeError);
    await expect(isLonLatInEpsgAreaOfUse(99999999, 0, 0, Number.NaN)).rejects.toThrow(RangeError);
  });
});

describe('units keep horizontal and vertical apart', () => {
  it('reports no horizontal unit for a vertical-only CRS and a vertical unit instead', async () => {
    // Registry: 5709 (NAP height) has a single height axis in metres.
    expect(await getEpsgUnits(5709)).toEqual({ vertical: { name: 'metre', metres: 1 } });
    const catalog = await createEpsgCrsCatalog();
    const entry = catalog.lookup(5709);
    expect(entry?.unitScale).toBeUndefined();
    expect(entry?.verticalUnitScale).toBe(1);
  });

  it('gives a compound CRS its horizontal and its vertical component unit', async () => {
    expect(await getEpsgUnits(7415)).toEqual({
      horizontal: { name: 'metre', metres: 1 },
      vertical: { name: 'metre', metres: 1 },
    });
    const entry = (await createEpsgCrsCatalog()).lookup(7415);
    expect(entry?.unitScale).toBe(1);
    expect(entry?.verticalUnitScale).toBe(1);
  });

  it('has no metre factor for the (bin) unit and exposes the name instead', async () => {
    const entries = await loadEpsgIndex();
    const bin: string[] = [];
    for (const entry of entries) {
      if ((await getEpsgUnits(entry.code))?.horizontal?.name === '(bin)') bin.push(entry.code);
    }
    expect(bin.length).toBe(4);
    const catalog = await createEpsgCrsCatalog();
    for (const code of bin) {
      expect(catalog.lookup(Number(code))?.unitScale).toBeUndefined();
      expect((await getEpsgUnits(code))?.horizontal?.metres).toBeUndefined();
    }
  });
});

describe('createEpsgCrsCatalog', () => {
  it('looks up name, kind, area of use and unit scale', async () => {
    const catalog = await createEpsgCrsCatalog();
    expect(catalog.lookup(2056)).toMatchObject({
      code: 2056,
      name: 'CH1903+ / LV95',
      kind: 'projected',
      areaOfUse: { west: 5.95, south: 45.81, east: 10.5, north: 47.81, crossesAntimeridian: false },
      unitScale: 1,
    });
    expect(catalog.lookup(2227)?.unitScale).toBeCloseTo(1200 / 3937, 9);
    const wgs84 = catalog.lookup(4326);
    expect(wgs84?.kind).toBe('geographic');
    expect(wgs84?.unitScale).toBeUndefined();
    expect(catalog.lookup(7415)?.kind).toBe('compound');
    expect(catalog.lookup(5709)?.kind).toBe('vertical');
    expect(catalog.lookup(99999999)).toBeUndefined();
  });

  it('fills the name from the index for every entry', async () => {
    const catalog = await createEpsgCrsCatalog();
    for (const entry of await loadEpsgIndex()) {
      expect(catalog.lookup(Number(entry.code))?.name).toBe(entry.name);
    }
  });

  it('returns a numeric code and rejects a non-number', async () => {
    const catalog = await createEpsgCrsCatalog();
    expect(typeof catalog.lookup(2056)?.code).toBe('number');
    expect(catalog.lookup('2056' as unknown as number)).toBeUndefined();
    expect(catalog.lookup(2056.5)).toBeUndefined();
    expect(catalog.lookup(Number.NaN)).toBeUndefined();
  });

  describe('several usages', () => {
    it('lookup returns the bounding hull, so it agrees with the per-code helper on the points it admits', async () => {
      // Registry: 2393 has two current usages, 25.5..28.51 E and 19.24..31.59 E.
      const entry = (await createEpsgCrsCatalog()).lookup(2393);
      expect(entry?.areaOfUse).toMatchObject({ west: 19.24, south: 59.75, east: 31.59, north: 70.09 });
      expect(entry?.areaOfUse?.contains(21, 65)).toBe(true);
      expect(await isLonLatInEpsgAreaOfUse(2393, 21, 65)).toBe(true);
    });

    it('is a superset of every usage box for all multi-usage CRSs, and none crosses the antimeridian', async () => {
      const catalog = await createEpsgCrsCatalog();
      let multi = 0;
      let crossing = 0;
      for (const entry of await loadEpsgIndex()) {
        const areas = (await getEpsgAreasOfUse(entry.code)) ?? [];
        if (areas.some(a => a.crossesAntimeridian)) crossing += 1;
        if (areas.length < 2) continue;
        multi += 1;
        // The hull is only defined for non-crossing boxes; a future dataset that breaks this must fail here.
        expect(areas.some(a => a.crossesAntimeridian), `EPSG:${entry.code}`).toBe(false);
        const hull = catalog.lookup(Number(entry.code))!.areaOfUse!;
        for (const a of areas) {
          expect(hull.west, entry.code).toBeLessThanOrEqual(a.west);
          expect(hull.east, entry.code).toBeGreaterThanOrEqual(a.east);
          expect(hull.south, entry.code).toBeLessThanOrEqual(a.south);
          expect(hull.north, entry.code).toBeGreaterThanOrEqual(a.north);
        }
      }
      expect(multi).toBe(15);
      expect(crossing).toBe(92);
    });
  });

  describe('antimeridian boxes', () => {
    it('are flagged, keep west > east and test wrap-aware through contains (3460 Fiji)', async () => {
      const area = (await createEpsgCrsCatalog()).lookup(3460)!.areaOfUse!;
      expect(area.crossesAntimeridian).toBe(true);
      expect(area.west).toBeGreaterThan(area.east);
      expect(area.contains(178, -17.7)).toBe(true); // east of the date line
      expect(area.contains(-179, -16.5)).toBe(true); // west of the date line
      expect(area.contains(180, -17)).toBe(true);
      expect(area.contains(0, -17)).toBe(false);
      expect(area.contains(-177.5, -17, 0.5)).toBe(false);
      expect(area.contains(-177.8, -17, 0.5)).toBe(true);
      // the naive consumer test is wrong here, which is why `crossesAntimeridian` and `contains` exist
      expect(-179 >= area.west && -179 <= area.east).toBe(false);
    });

    it('every catalogue entry carries the flag consistently with west > east', async () => {
      const catalog = await createEpsgCrsCatalog();
      let crossing = 0;
      for (const entry of await loadEpsgIndex()) {
        const area = catalog.lookup(Number(entry.code))?.areaOfUse;
        if (!area) continue;
        expect(area.crossesAntimeridian, entry.code).toBe(area.west > area.east);
        const mid = area.crossesAntimeridian ? (area.west + area.east + 360) / 2 : (area.west + area.east) / 2;
        const lon = mid > 180 ? mid - 360 : mid;
        expect(area.contains(lon, (area.south + area.north) / 2), entry.code).toBe(true);
        if (area.crossesAntimeridian) crossing += 1;
      }
      expect(crossing).toBe(92);
    });
  });

  it('resolves the name forms the index knows', async () => {
    const catalog = await createEpsgCrsCatalog();
    expect(catalog.resolveName('CH1903+ / LV95')).toBe(2056);
    expect(catalog.resolveName('  ch1903+  /  lv95 ')).toBe(2056);
    expect(catalog.resolveName('EPSG:21781')).toBe(21781);
    expect(catalog.resolveName('28992')).toBe(28992);
    expect(catalog.resolveName('EPSG:99999999')).toBeUndefined();
    expect(catalog.resolveName('no such crs')).toBeUndefined();
  });

  it('resolves the URN, double-colon and space code forms', async () => {
    const catalog = await createEpsgCrsCatalog();
    expect(catalog.resolveName('urn:ogc:def:crs:EPSG::2056')).toBe(2056);
    expect(catalog.resolveName('URN:OGC:DEF:CRS:EPSG:9.9.1:2056')).toBe(2056);
    expect(catalog.resolveName('EPSG::4326')).toBe(4326);
    expect(catalog.resolveName('EPSG 2056')).toBe(2056);
    expect(catalog.resolveName('epsg:2056')).toBe(2056);
    expect(catalog.resolveName('urn:ogc:def:crs:EPSG::99999999')).toBeUndefined();
  });

  it('does not resolve one-word aliases, nicknames or ambiguous names', async () => {
    const catalog = await createEpsgCrsCatalog();
    for (const alias of ['Israel', 'Madrid', 'Levant', 'N60', 'LV95', 'wgs84', 'rd new', 'lambert-93']) {
      expect(catalog.resolveName(alias), alias).toBeUndefined();
    }
    // multi-word aliases and full names still resolve
    expect(catalog.resolveName('Israel 1993')).toBe(4141);
    expect(catalog.resolveName('WGS 84')).toBe(4326);
  });
});

describe('dataset version', () => {
  it('records the registry dataset version next to the main index version', async () => {
    const version = await loadEpsgExtentsDatasetVersion();
    // Pinned to the dataset the expected values above were read from (and the README names), not to
    // the generated constant itself: regenerating against another dataset must update this on purpose.
    expect(version).toBe('13.106');
    expect(EPSG_EXTENTS_DATASET_VERSION).toBe(version);
    expect(await loadEpsgIndexDatasetVersion()).toMatch(/^\d+\.\d+$/);
  });
});

describe('generator safety', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const script = path.join(root, 'scripts/generate-epsg-extents.ts');
  const tsx = path.join(root, 'node_modules/.bin/tsx');

  const run = (args: string[], env: Record<string, string> = {}, cwd = path.join(root, 'packages/data')) =>
    new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
      execFile(tsx, [script, ...args], { cwd, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
      });
    });

  const serve = async (known: Set<string>) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '';
      const send = (body: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
      const code = /\/CoordRefSystem\/(\d+)$/.exec(url)?.[1];
      if (code && known.has(code)) return send({ Usage: [{ Extent: { Code: 1 } }], CoordSys: { Code: 2 } });
      if (url.endsWith('/Extent/1')) return send({ BoundingBoxWestBoundLongitude: 1, BoundingBoxSouthBoundLatitude: 2, BoundingBoxEastBoundLongitude: 3, BoundingBoxNorthBoundLatitude: 4 });
      if (url.endsWith('/CoordSystem/2')) return send({ Axis: [{ Unit: { Code: 9001 } }] });
      if (url.endsWith('/Unit/9001')) return send({ Name: 'metre', Type: 'length', FactorB: 1, FactorC: 1, TargetUnit: { Code: 9001 } });
      res.statusCode = 404; res.end();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
  };

  it('refuses --limit without --out or --stdout and leaves the committed file alone', async () => {
    const committed = path.join(root, 'packages/data/src/generated/epsg-extents.generated.ts');
    const before = fs.statSync(committed).mtimeMs;
    const result = await run(['--limit=3']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--out');
    expect(fs.statSync(committed).mtimeMs).toBe(before);
  }, 30000);

  it('refuses a partial run aimed at the committed file by an explicit --out, from any cwd', async () => {
    const committed = path.join(root, 'packages/data/src/generated/epsg-extents.generated.ts');
    const before = fs.statSync(committed).mtimeMs;
    for (const [cwd, target] of [
      [root, 'packages/data/src/generated/epsg-extents.generated.ts'],
      [path.join(root, 'packages/data'), 'src/generated/epsg-extents.generated.ts'],
      [root, committed],
    ] as const) {
      const result = await run(['--limit=3', `--out=${target}`, '--dataset-version=1.0'], { EPSG_API_BASE: 'http://127.0.0.1:9' }, cwd);
      expect(result.code, target).toBe(2);
      expect(result.stderr).toContain('committed file');
    }
    expect(fs.statSync(committed).mtimeMs).toBe(before);
  }, 60000);

  it('rejects non-numeric or out-of-range options and writes nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epsg-gen-'));
    try {
      const out = path.join(dir, 'x.ts');
      for (const bad of ['--concurrency=NaN', '--concurrency=0', '--concurrency=9', '--concurrency=', '--delay-ms=NaN', '--delay-ms=-1', '--limit=NaN', '--limit=0']) {
        const result = await run([bad, `--out=${out}`, '--dataset-version=1.0'], { EPSG_API_BASE: 'http://127.0.0.1:9' });
        expect(result.code, bad).toBe(2);
        expect(result.stderr, bad).toContain('must be an integer');
      }
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it('exits non-zero and writes nothing when an index code has no row and is not allow-listed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epsg-gen-'));
    const { server, base } = await serve(new Set(['2000', '2001'])); // third index code is 404
    try {
      const out = path.join(dir, 'x.ts');
      const result = await run(['--limit=3', `--out=${out}`, '--dataset-version=1.0', '--delay-ms=0'], { EPSG_API_BASE: base });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('not allow-listed');
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it('writes through a temp file when the allow-list gives the reason, from another directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epsg-gen-'));
    const { server, base } = await serve(new Set(['2000', '2001']));
    try {
      const allow = path.join(dir, 'allow.json');
      fs.writeFileSync(allow, JSON.stringify({ [(await loadEpsgIndex())[2].code]: 'test: not served' }));
      const out = path.join(dir, 'x.ts');
      const result = await run(['--limit=3', `--out=${out}`, '--dataset-version=1.0', '--delay-ms=0'], { EPSG_API_BASE: base, EPSG_EXTENTS_ALLOWLIST: allow }, dir);
      expect(result.code, result.stderr).toBe(0);
      expect(fs.readdirSync(dir).sort()).toEqual(['allow.json', 'x.ts']);
      expect(fs.readFileSync(out, 'utf8')).toContain("EPSG_EXTENTS_DATASET_VERSION = '1.0'");
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it('emits the ownership acknowledgement, terms URL, as-is statement and transformations', async () => {
    const { server, base } = await serve(new Set(['2000', '2001', '2002']));
    try {
      const result = await run(['--limit=3', '--stdout', '--dataset-version=1.0', '--delay-ms=0'], { EPSG_API_BASE: base });
      expect(result.code, result.stderr).toBe(0);
      // stdout is the generated module and nothing else, so redirecting it yields valid TypeScript.
      expect(result.stdout.startsWith('/* This Source Code Form')).toBe(true);
      expect(result.stdout).not.toContain('rows without a unit');
      expect(result.stderr).toContain('rows without a unit');
      for (const notice of [
        'EPSG Dataset version: 1.0',
        'International Association of Oil',
        'https://epsg.org/terms-of-use.html',
        '"AS IS"',
        'Derived subset',
        'rounded to 6 decimal places',
        'dropped',
      ]) {
        expect(result.stdout).toContain(notice);
      }
    } finally {
      server.close();
    }
  }, 60000);
});
