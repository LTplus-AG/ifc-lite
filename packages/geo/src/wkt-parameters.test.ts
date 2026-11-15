/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Map-projection parameters of a WKT: the names proj4's reader maps, the
 * unit a WKT2 parameter without one has (ISO 19162:2019 9.3.4: decimal
 * degrees), and the refusal when the reader comes back without a parameter
 * the projection needs. These used to rest on a pnpm patch of wkt-parser
 * 1.6.0 that npm consumers of this package never got.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import parseWkt from 'wkt-parser';

import { configureCrsDiagnostics } from './diagnostics.js';
import { resolveCrs, type CrsInput } from './index.js';
import { missingProjectionParameters, withImpliedParameterUnits } from './wkt-parameters.js';

const DEG = Math.PI / 180;
const WGS84_BASE = 'BASEGEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563]]]';
const tmWkt2 = (parameters: string) => `PROJCRS["Custom TM",${WGS84_BASE},CONVERSION["tm",METHOD["Transverse Mercator"],${parameters}],`
  + 'CS[Cartesian,2],AXIS["E",east],AXIS["N",north],LENGTHUNIT["metre",1]]';

/** The reviewer's case: WKT1-style names, central meridian 7.5, no units. */
const TM_WKT1_NAMES = tmWkt2('PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",7.5],'
  + 'PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0]');
/** The same projection with EPSG names and every unit stated: the unambiguous reference. */
const TM_EXPLICIT = tmWkt2('PARAMETER["Latitude of natural origin",0,ANGLEUNIT["degree",0.0174532925199433]],'
  + 'PARAMETER["Longitude of natural origin",7.5,ANGLEUNIT["degree",0.0174532925199433]],'
  + 'PARAMETER["Scale factor at natural origin",0.9996,SCALEUNIT["unity",1]],'
  + 'PARAMETER["False easting",500000,LENGTHUNIT["metre",1]],PARAMETER["False northing",0,LENGTHUNIT["metre",1]]');

/** Collect diagnostics for the duration of `run`. */
async function diagnosticsOf(run: () => Promise<void>): Promise<string[]> {
  const messages: string[] = [];
  const previous = configureCrsDiagnostics((message) => { messages.push(message); });
  try {
    await run();
  } finally {
    configureCrsDiagnostics(previous);
  }
  return messages;
}

describe('the installed WKT reader', () => {
  it('maps WKT1-style parameter names inside WKT2 (proj4js/wkt-parser#63, released in 1.7.0)', () => {
    const parsed = parseWkt(TM_EXPLICIT.replace('Longitude of natural origin', 'central_meridian')) as Record<string, unknown>;
    assert.ok(Math.abs(Number(parsed.long0) - 7.5 * DEG) < 1e-15, `long0 ${parsed.long0}`);
  });
});

describe('WKT2 parameters without a unit (ISO 19162:2019 9.3.4)', () => {
  it('reads an angle as decimal degrees, leaving lengths and scale factors as they are', () => {
    const parsed = parseWkt(withImpliedParameterUnits(TM_WKT1_NAMES)) as Record<string, number>;
    assert.ok(Math.abs(parsed.long0 - 7.5 * DEG) < 1e-15, `long0 ${parsed.long0}`);
    assert.equal(parsed.lat0, 0);
    assert.equal(parsed.k0, 0.9996);
    assert.equal(parsed.x0, 500000);
  });

  it('places the point where the same WKT with stated units does: 7.5 degrees east, not 7.5 radians', async () => {
    const implied = await resolveCrs({ wkt: TM_WKT1_NAMES });
    const explicit = await resolveCrs({ wkt: TM_EXPLICIT });
    assert.ok(implied && explicit);
    const point = implied.toWgs84([500000, 5200000]);
    const reference = explicit.toWgs84([500000, 5200000]);
    assert.ok(point && reference);
    // On the central meridian the longitude is the central meridian itself.
    // Before, 7.5 was taken as radians and the point sat at 69.72 degrees east.
    assert.ok(Math.abs(point[0] - 7.5) < 1e-9, `longitude ${point[0]}`);
    assert.ok(Math.abs(point[0] - reference[0]) < 1e-12 && Math.abs(point[1] - reference[1]) < 1e-12);
  });

  it('keeps a stated unit, and touches neither WKT1 nor a transformation', () => {
    assert.equal(withImpliedParameterUnits(TM_EXPLICIT), TM_EXPLICIT);
    const grads = tmWkt2('PARAMETER["Longitude of natural origin",10,ANGLEUNIT["grad",0.015707963267949]]');
    assert.equal(withImpliedParameterUnits(grads), grads);
    const wkt1 = 'PROJCS["x",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],UNIT["degree",0.0174532925199433]],'
      + 'PROJECTION["Transverse_Mercator"],PARAMETER["central_meridian",9],UNIT["metre",1]]';
    assert.equal(withImpliedParameterUnits(wkt1), wkt1);
    // ABRIDGEDTRANSFORMATION rotations are arc-seconds by their own rule.
    const bound = `BOUNDCRS[SOURCECRS[${TM_EXPLICIT}],TARGETCRS[GEOGCRS["WGS 84"]],ABRIDGEDTRANSFORMATION["t",`
      + 'METHOD["Position Vector transformation"],PARAMETER["X-axis rotation",0.202]]]';
    assert.equal(withImpliedParameterUnits(bound), bound);
  });

  it('adds the unit after the value, before an identifier, and ignores brackets inside names', () => {
    const wkt = tmWkt2('PARAMETER["Longitude of natural origin [x]",-3.5e0,ID["EPSG",8802]]');
    assert.equal(
      withImpliedParameterUnits(wkt),
      tmWkt2('PARAMETER["Longitude of natural origin [x]",-3.5e0,ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",8802]]'),
    );
  });
});

describe('a parse without the parameters its projection needs', () => {
  it('is caught on the unpatched wkt-parser 1.6.0 result for WKT1-style names', () => {
    // What wkt-parser 1.6.0 returned for TM_WKT1_NAMES: the names land as
    // raw keys and long0/k0 stay unset, so proj4 would use 0 and 1.
    const unpatched = {
      projName: 'Transverse Mercator', x0: 500000, y0: 0,
      central_meridian: 7.5, latitude_of_origin: 0, scale_factor: 0.9996,
    };
    assert.deepEqual(missingProjectionParameters(unpatched), ['long0', 'k0']);
    assert.deepEqual(missingProjectionParameters(parseWkt(withImpliedParameterUnits(TM_WKT1_NAMES))), []);
    assert.deepEqual(missingProjectionParameters({ projName: 'Krovak' }), [], 'an unlisted method is not checked');
    // #10385 review: the second parallel of a 2SP, the scale factor of a 1SP.
    assert.deepEqual(missingProjectionParameters({ projName: 'Lambert Conic Conformal (2SP)', long0: 0.05, lat0: 0.8, lat1: 0.85 }), ['lat2']);
    assert.deepEqual(missingProjectionParameters({ projName: 'Lambert_Conformal_Conic_1SP', long0: 0.04, lat0: 0.86 }), ['k0']);
  });

  it('refuses the CRS rather than placing it on the wrong meridian, and says why', async () => {
    // A parameter spelling no reader version maps behaves like the unpatched reader did.
    const unrecognised = TM_WKT1_NAMES.replace('central_meridian', 'CentralMeridianOfZone');
    let resolved: Awaited<ReturnType<typeof resolveCrs>> | undefined;
    const messages = await diagnosticsOf(async () => { resolved = await resolveCrs({ wkt: unrecognised }); });
    assert.equal(resolved, null);
    assert.ok(messages.some((message) => message.includes('without long0')), messages.join('\n'));
  });

  it('does not fall back to an EPSG code given beside a refused WKT (#10385 review)', async () => {
    const unrecognised = TM_WKT1_NAMES.replace('central_meridian', 'CentralMeridianOfZone');
    const quietly = async (input: CrsInput) => {
      const previous = configureCrsDiagnostics(null);
      try {
        return await resolveCrs(input);
      } finally {
        configureCrsDiagnostics(previous);
      }
    };
    assert.equal(await quietly({ wkt: unrecognised, epsg: 32632 }), null, 'the custom CRS is not replaced by UTM 32N');
    // An unreadable WKT still falls back, as documented.
    assert.equal((await quietly({ wkt: 'VERTCRS["height only"]', epsg: 32632 }))?.epsg, 32632);
  });

  it('refuses a 2SP whose second parallel the reader did not recognise (#10385 review)', async () => {
    const wkt = 'PROJCRS["x",' + WGS84_BASE + ',CONVERSION["c",METHOD["Lambert Conic Conformal (2SP)"],'
      + 'PARAMETER["Latitude of false origin",46.5],PARAMETER["Longitude of false origin",3],'
      + 'PARAMETER["Latitude of 1st standard parallel",49],PARAMETER["SecondParallelNorth",44],'
      + 'PARAMETER["Easting at false origin",700000],PARAMETER["Northing at false origin",6600000]],'
      + 'CS[Cartesian,2],AXIS["E",east],AXIS["N",north],LENGTHUNIT["metre",1]]';
    let resolved: Awaited<ReturnType<typeof resolveCrs>> | undefined;
    const messages = await diagnosticsOf(async () => { resolved = await resolveCrs({ wkt }); });
    assert.equal(resolved, null);
    assert.ok(messages.some((message) => message.includes('without lat2')), messages.join('\n'));
  });

  // Each checked method, in WKT1 and in WKT2 with EPSG names, must still
  // resolve: the check may refuse only what the reader really lost.
  const WGS84_GEOGCS = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
  const wkt1 = (method: string, parameters: [string, number][]) => `PROJCS["x",${WGS84_GEOGCS},PROJECTION["${method}"],`
    + `${parameters.map(([name, value]) => `PARAMETER["${name}",${value}]`).join(',')},UNIT["metre",1]]`;
  const wkt2 = (method: string, parameters: [string, number][]) => `PROJCRS["x",${WGS84_BASE},CONVERSION["c",METHOD["${method}"],`
    + `${parameters.map(([name, value]) => `PARAMETER["${name}",${value}]`).join(',')}],CS[Cartesian,2],AXIS["E",east],AXIS["N",north],LENGTHUNIT["metre",1]]`;
  const CASES: { label: string; wkt: string; at: [number, number]; expect: [number, number] }[] = [
    {
      label: 'oblique stereographic, WKT1',
      wkt: wkt1('Oblique_Stereographic', [['latitude_of_origin', 52.156], ['central_meridian', 5.387], ['scale_factor', 0.9999079], ['false_easting', 155000], ['false_northing', 463000]]),
      at: [155000, 463000], expect: [5.387, 52.156],
    },
    {
      label: 'oblique stereographic, WKT2',
      wkt: wkt2('Oblique Stereographic', [['Latitude of natural origin', 52.156], ['Longitude of natural origin', 5.387], ['Scale factor at natural origin', 0.9999079], ['False easting', 155000], ['False northing', 463000]]),
      at: [155000, 463000], expect: [5.387, 52.156],
    },
    {
      label: 'Lambert conic conformal 2SP, WKT1',
      wkt: wkt1('Lambert_Conformal_Conic_2SP', [['standard_parallel_1', 49], ['standard_parallel_2', 44], ['latitude_of_origin', 46.5], ['central_meridian', 3], ['false_easting', 700000], ['false_northing', 6600000]]),
      at: [700000, 6600000], expect: [3, 46.5],
    },
    {
      label: 'Lambert conic conformal 2SP, WKT2',
      wkt: wkt2('Lambert Conic Conformal (2SP)', [['Latitude of false origin', 46.5], ['Longitude of false origin', 3], ['Latitude of 1st standard parallel', 49], ['Latitude of 2nd standard parallel', 44], ['Easting at false origin', 700000], ['Northing at false origin', 6600000]]),
      at: [700000, 6600000], expect: [3, 46.5],
    },
    {
      label: 'Lambert conic conformal 1SP, WKT1',
      wkt: wkt1('Lambert_Conformal_Conic_1SP', [['latitude_of_origin', 49.5], ['central_meridian', 2.3372], ['scale_factor', 0.999877341], ['false_easting', 600000], ['false_northing', 200000]]),
      at: [600000, 200000], expect: [2.3372, 49.5],
    },
    {
      label: 'Lambert conic conformal 1SP, WKT2',
      wkt: wkt2('Lambert Conic Conformal (1SP)', [['Latitude of natural origin', 49.5], ['Longitude of natural origin', 2.3372], ['Scale factor at natural origin', 0.999877341], ['False easting', 600000], ['False northing', 200000]]),
      at: [600000, 200000], expect: [2.3372, 49.5],
    },
    {
      label: 'Mercator 1SP, WKT1',
      wkt: wkt1('Mercator_1SP', [['central_meridian', 10], ['scale_factor', 1], ['false_easting', 0], ['false_northing', 0]]),
      at: [0, 0], expect: [10, 0],
    },
    {
      label: 'Mercator variant A, WKT2',
      wkt: wkt2('Mercator (variant A)', [['Latitude of natural origin', 0], ['Longitude of natural origin', 10], ['Scale factor at natural origin', 1], ['False easting', 0], ['False northing', 0]]),
      at: [0, 0], expect: [10, 0],
    },
  ];
  for (const { label, wkt, at, expect } of CASES) {
    it(`still resolves a ${label}`, async () => {
      const crs = await resolveCrs({ wkt });
      assert.ok(crs, `${label} was refused`);
      const position = crs.toWgs84(at);
      assert.ok(position, `${label} did not convert`);
      // The projection origin maps to the stated origin.
      assert.ok(Math.abs(position[0] - expect[0]) < 1e-6 && Math.abs(position[1] - expect[1]) < 1e-6, `${label}: ${position}`);
    });
  }
});
