/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The public transformer against PROJ (`__fixtures__/proj-oracle.json`) and
 * against its own stated contract: precedence of the CRS input, units and axis
 * order, the untouched height, and no request without an installed loader.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import PROJ_ORACLE from './__fixtures__/proj-oracle.json' with { type: 'json' };
import { configureCrsLoaders, resolveCrs, type CrsInput } from './index.js';

/** Oracle cases that are registered CRSs, with the input that names each. */
const REGISTERED: { prefix: string; input: CrsInput; epsg: number }[] = [
  { prefix: 'UTM 32N', input: { epsg: 32632 }, epsg: 32632 },
  { prefix: 'ETRS89 / UTM 33N', input: { name: 'ETRS89 / UTM zone 33N' }, epsg: 25833 },
  { prefix: 'RGF93 / Lambert-93', input: { epsg: 'EPSG:2154' }, epsg: 2154 },
];

/** UTM 32N written out as WKT2, without an EPSG identifier. */
const UTM32_WKT =
  'PROJCRS["Site grid",BASEGEOGCRS["WGS 84",DATUM["World Geodetic System 1984",'
  + 'ELLIPSOID["WGS 84",6378137,298.257223563]]],CONVERSION["tm",METHOD["Transverse Mercator"],'
  + 'PARAMETER["Latitude of natural origin",0,ANGLEUNIT["degree",0.0174532925199433]],'
  + 'PARAMETER["Longitude of natural origin",9,ANGLEUNIT["degree",0.0174532925199433]],'
  + 'PARAMETER["Scale factor at natural origin",0.9996,SCALEUNIT["unity",1]],'
  + 'PARAMETER["False easting",500000,LENGTHUNIT["metre",1]],'
  + 'PARAMETER["False northing",0,LENGTHUNIT["metre",1]]],'
  + 'CS[Cartesian,2],AXIS["E",east],AXIS["N",north],LENGTHUNIT["metre",1]]';

describe('resolveCrs: positions and grid factors match PROJ', () => {
  for (const { prefix, input, epsg } of REGISTERED) {
    const oracle = PROJ_ORACLE.cases.find((c) => c.name.startsWith(prefix));
    assert.ok(oracle, `oracle case ${prefix}`);
    it(`${oracle.name} from ${JSON.stringify(input)}`, async () => {
      const crs = await resolveCrs(input);
      assert.ok(crs);
      assert.equal(crs.kind, 'projected');
      assert.equal(crs.epsg, epsg);
      assert.equal(crs.datumShift, 'as-defined');
      for (const p of oracle.points) {
        const wgs84 = crs.toWgs84([p.E, p.N]);
        assert.ok(wgs84);
        // 1e-9 degrees is 0.1 mm on the ground.
        assert.ok(Math.abs(wgs84[0] - p.lon) < 1e-9, `lon ${wgs84[0]} vs PROJ ${p.lon}`);
        assert.ok(Math.abs(wgs84[1] - p.lat) < 1e-9, `lat ${wgs84[1]} vs PROJ ${p.lat}`);
        const back = crs.fromWgs84([p.lon, p.lat]);
        assert.ok(back);
        assert.ok(Math.hypot(back[0] - p.E, back[1] - p.N) < 1e-4, `E/N ${back} vs PROJ ${p.E}, ${p.N}`);
        const factors = crs.gridFactors(p.E, p.N);
        assert.ok(factors);
        assert.ok(Math.abs(factors.gamma - p.gammaTrueNorth) < 1e-9, `gamma ${factors.gamma} vs PROJ ${p.gammaTrueNorth}`);
        assert.ok(Math.abs(factors.pointScale - p.kWgs84) < 1e-9, `k ${factors.pointScale} vs PROJ ${p.kWgs84}`);
      }
    });
  }
});

describe('resolveCrs: the CRS input', () => {
  it('resolves the Swiss aliases to their EPSG codes', async () => {
    assert.equal((await resolveCrs({ name: 'LV95' }))?.epsg, 2056);
    assert.equal((await resolveCrs({ name: 'CH1903 / LV03' }))?.epsg, 21781);
  });

  it('takes epsg over name, and a readable WKT over both', async () => {
    const byCode = await resolveCrs({ epsg: 32632, name: 'LV95' });
    assert.equal(byCode?.epsg, 32632);
    const byWkt = await resolveCrs({ epsg: 2056, name: 'LV95', wkt: UTM32_WKT });
    assert.ok(byCode && byWkt);
    assert.equal(byWkt.epsg, null);
    const point = PROJ_ORACLE.cases[0].points[1];
    const fromWkt = byWkt.toWgs84([point.E, point.N]);
    const fromCode = byCode.toWgs84([point.E, point.N]);
    assert.ok(fromWkt && fromCode);
    assert.ok(Math.abs(fromWkt[0] - fromCode[0]) < 1e-12 && Math.abs(fromWkt[1] - fromCode[1]) < 1e-12);
  });

  it('lets a readable WKT define the CRS even next to an unreadable epsg (#10385 review)', async () => {
    const crs = await resolveCrs({ wkt: UTM32_WKT, epsg: 'not a code' });
    assert.ok(crs, 'the WKT is authoritative');
    assert.equal(crs.kind, 'projected');
    assert.equal(await resolveCrs({ wkt: 'VERTCRS["height only"]', epsg: 'not a code', name: 'LV95' }), null,
      'an unreadable WKT does not turn an unreadable epsg into the name');
  });

  it('is null for an input that names no CRS', async () => {
    assert.equal(await resolveCrs({}), null);
    assert.equal(await resolveCrs({ epsg: 'not a code' }), null);
    assert.equal(await resolveCrs({ name: 'Somewhere local' }), null);
  });
});

describe('resolveCrs: coordinates', () => {
  it('returns the height it was given, and only when it was given one', async () => {
    const crs = await resolveCrs({ epsg: 32632 });
    assert.ok(crs);
    const p = PROJ_ORACLE.cases[0].points[0];
    assert.equal(crs.toWgs84([p.E, p.N])?.length, 2);
    assert.equal(crs.toWgs84([p.E, p.N, 412.5])?.[2], 412.5);
    assert.equal(crs.fromWgs84([p.lon, p.lat, 412.5])?.[2], 412.5);
  });

  it('reads a geographic CRS in degrees, longitude first, and refuses what is not a position', async () => {
    const crs = await resolveCrs({ epsg: 4326 });
    assert.ok(crs);
    assert.equal(crs.kind, 'geographic');
    assert.deepEqual(crs.toWgs84([8.54, 47.37]), [8.54, 47.37]);
    assert.equal(crs.toWgs84([47.37, 98.54]), null, 'a latitude of 98.54 is not a position');
    assert.equal(crs.toWgs84([Number.NaN, 47.37]), null);
    assert.equal(crs.gridFactors(8.54, 47.37), null, 'a geographic CRS has no grid');
  });
});

describe('resolveCrs: network', () => {
  it('makes no request unless the host installed a loader', async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('the engine must not reach the network by itself');
    });
    // Not in the bundled index: only a definition loader could resolve it.
    assert.equal(await resolveCrs({ epsg: 999999 }), null);
    // Has a precision grid: only a grid loader could fetch it.
    const lv03 = await resolveCrs({ name: 'LV03' });
    assert.equal(lv03?.datumShift, 'helmert-approximation');
    assert.equal(fetch.mock.callCount(), 0);
  });

  it('asks the installed definition loader for a code the bundled index lacks', async () => {
    const asked: string[] = [];
    const previous = configureCrsLoaders({
      epsgDefinition: async (code) => {
        asked.push(code);
        return '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs';
      },
    });
    try {
      const crs = await resolveCrs({ epsg: 999998 });
      assert.deepEqual(asked, ['999998']);
      const p = PROJ_ORACLE.cases[0].points[0];
      const wgs84 = crs?.toWgs84([p.E, p.N]);
      assert.ok(wgs84 && Math.abs(wgs84[0] - p.lon) < 1e-9 && Math.abs(wgs84[1] - p.lat) < 1e-9);
    } finally {
      configureCrsLoaders(previous);
    }
  });
});
