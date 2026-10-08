/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import proj4 from 'proj4';
import { writeArrayBuffer } from 'geotiff';
import { lookupEpsgByCode } from '@ifc-lite/data';

import { PRECISION_GRIDS, isHorizontalOffsetGrid, resolvePrecisionDef, hasLoadedPrecisionGrid, hasFailedPrecisionGrid } from './precision-grids.js';

describe('precision-grids datum-shift table (#1357)', () => {
  it('treats only >=2-band grids as horizontal datum shifts', () => {
    // 1-band = vertical/height model (e.g. a quasigeoid) — proj4's +nadgrids
    // reader would dereference a missing 2nd band and throw.
    assert.equal(isHorizontalOffsetGrid(1), false);
    assert.equal(isHorizontalOffsetGrid(0), false);
    assert.equal(isHorizontalOffsetGrid(2), true); // lat + lon offsets
    assert.equal(isHorizontalOffsetGrid(4), true); // + accuracy bands
  });

  it('never registers the vertical cz_cuzk_CR-2005 grid as a horizontal +nadgrids', () => {
    // cz_cuzk_CR-2005.tif is a VERTICAL_OFFSET (ETRS89 -> Baltic height) grid;
    // using it as a horizontal datum shift crashed proj4 and forced the
    // +towgs84 fallback (the "grid failed" badge). It must not reappear.
    for (const [code, spec] of Object.entries(PRECISION_GRIDS)) {
      assert.ok(
        !/cz_cuzk_CR-2005/i.test(spec.filename),
        `EPSG:${code} references the vertical CR-2005 grid (${spec.filename})`,
      );
      assert.ok(
        !spec.proj4.includes('cz_cuzk_CR-2005'),
        `EPSG:${code} proj4 string references the vertical CR-2005 grid`,
      );
    }
  });

  it('drops the broken S-JTSK (5514 / 2065) precision-grid entries', () => {
    // No single horizontal grid takes S-JTSK -> ETRS89 in PROJ-data, so these
    // CRSs intentionally fall back to the bundled +towgs84 (~1 m) with no grid.
    assert.equal(PRECISION_GRIDS['5514'], undefined);
    assert.equal(PRECISION_GRIDS['2065'], undefined);
  });

  it('keeps compatible horizontal grids (e.g. NL RD)', () => {
    assert.ok(PRECISION_GRIDS['28992'], 'NL RD should keep its precision grid');
    assert.equal(PRECISION_GRIDS['5513'], undefined, 'JTSK03 → JTSK is not S-JTSK → WGS84');
  });
});

// Independent projection controls from PROJ 9.8 / EPSG database (pyproj 3.8):
// pyproj.Proj(CRS.from_epsg(code))(longitude, latitude), using the centre of
// each CRS area of use. +nadgrids=null isolates projection and prime-meridian
// correctness from the separately validated datum-grid offsets. GIS x/y
// order matches IFC Eastings/Northings, regardless of the EPSG axis order.
const PROJECTION_CONTROLS: ReadonlyArray<readonly [string, number, number, number, number]> = [
  ["28992", 142863.9788134, 470673.1124919, 5.21, 52.225],
  ["7415", 142863.9788134, 470673.1124919, 5.21, 52.225],
  ["27700", 304969.2073708, 610584.9936767, -3.5, 55.38],
  ["31370", 155853.5533667, 132631.7548083, 4.45, 50.505],
  ["31466", 2547602.314039, 5702898.5284637, 6.685, 51.46],
  ["31467", 3500349.5859045, 5671528.2913267, 9.005, 51.18],
  ["31468", 4500351.0209789, 5650393.2213549, 12.005, 50.99],
  ["31469", 5402198.7125372, 5401571.51951, 13.67, 48.745],
  ["31287", 401250.1389049, 423337.9362568, 13.35, 47.71],
  ["31254", 26648.147619, 227897.5640976, 10.685, 47.19],
  ["31255", 125.3306909, 272859.8097567, 13.335, 47.595],
  ["31256", -24972.8532146, 294592.1250104, 16.0, 47.79],
  ["27561", 552532.479988, 215776.0770782, 1.68, 49.64],
  ["27562", 529598.0724253, 199857.2693011, 1.415, 46.795],
  ["27563", 650033.9920204, 177414.2724842, 2.96, 43.895],
  ["27564", 555391.6231798, 210528.5700367, 9.065, 42.19],
  ["27571", 552532.479988, 1215776.0770782, 1.68, 49.64],
  ["27572", 549771.5393519, 2192985.1139479, 1.68, 46.735],
  ["27573", 650033.9920204, 3177414.2724842, 2.96, 43.895],
  ["27574", 555391.6231798, 4210528.5700367, 9.065, 42.19],
  ["21781", 659938.9861671, 184470.9666418, 8.225, 46.81],
  ["23029", 500000.0, 5457579.8427474, -9.0, 49.27],
  ["23030", 500296.5899427, 6414939.2088612, -2.995, 57.875],
  ["23031", 500000.0, 6707811.9834799, 3.0, 60.505],
  ["27493", 22261.5549504, -12453.8473519, -7.875, 39.555],
  ["26710", 500313.7400577, 6179710.9455152, -122.995, 55.765],
  ["26711", 500000.0, 5819771.233317, -117.0, 52.53],
  ["26712", 500000.0, 5397778.6720727, -111.0, 48.735],
  ["26713", 500000.0, 5387218.5567574, -105.0, 48.64],
  ["26714", 500000.0, 5334420.6367176, -99.0, 48.165],
  ["26715", 500000.0, 5293296.907136, -93.0, 47.795],
  ["26716", 499612.1647007, 5083274.5341902, -87.005, 45.905],
  ["26717", 500000.0, 5038834.3778368, -81.0, 45.505],
  ["26718", 500000.0, 5649050.2439129, -75.0, 50.995],
  ["26719", 500000.0, 6471921.4870439, -69.0, 58.39],
  ["26703", 500262.7120005, 6863395.1740773, -164.995, 61.905],
  ["26704", 500254.6149302, 6968120.3227634, -158.995, 62.845],
  ["26705", 500249.5405511, 7033302.2283026, -152.995, 63.43],
  ["26706", 500243.7839409, 7106847.3099126, -146.995, 64.09],
  ["26707", 500000.0, 7044444.9709618, -141.0, 63.53],
  ["26708", 500000.0, 6964220.7148623, -135.0, 62.81],
  ["26709", 500000.0, 6718586.5828076, -129.0, 60.605],
  ["20248", 500000.0, 6348700.3923376, 105.0, -33.0],
  ["20249", 560737.8133182, 6956360.5450641, 111.615, -27.515],
  ["20250", 500000.0, 7171924.7511041, 117.0, -25.57],
  ["20251", 500507.5104063, 7316424.479042, 123.005, -24.265],
  ["20252", 499488.5009015, 7429903.0111643, 128.995, -23.24],
  ["20253", 500505.3843178, 7257741.8074844, 135.005, -24.795],
  ["20254", 500506.2520001, 7281547.5393784, 141.005, -24.58],
  ["20255", 500507.5699489, 7318085.2495538, 147.005, -24.25],
  ["20256", 500000.0, 7303691.8053289, 153.0, -24.38],
  ["20257", 500506.1514721, 7278779.4660113, 159.005, -24.605],
  ["20258", 270217.1467323, 6597293.8906885, 162.6, -30.735],
  ["20348", 500000.0, 6348700.3923376, 105.0, -33.0],
  ["20349", 560737.8133182, 6956360.5450641, 111.615, -27.515],
  ["20350", 500000.0, 7171924.7511041, 117.0, -25.57],
  ["20351", 500507.5104063, 7316424.479042, 123.005, -24.265],
  ["20352", 500000.0, 7433224.1175332, 129.0, -23.21],
  ["20353", 500000.0, 6563182.4868055, 135.0, -31.065],
  ["20354", 500508.5768591, 7346317.8486296, 141.005, -23.995],
  ["20355", 500000.0, 7621399.3472938, 147.0, -21.51],
  ["20356", 379994.1743268, 7168615.6160017, 151.805, -25.595],
  ["27200", 2467748.741421, 6054681.6575574, 172.5, -40.715],
  ["29101", 5469772.4584103, 8410163.7191169, -49.645, -14.335],
  ["29168", 500000.0, 680340.9963037, -75.0, 6.155],
  ["29169", 500000.0, 691948.0538802, -69.0, 6.26],
  ["29170", 500553.4143585, 656021.5963658, -62.995, 5.935],
  ["29171", 500000.0, 540506.9458915, -57.0, 4.89],
  ["29172", 574953.2820914, 413971.2012395, -50.325, 3.745],
  ["29187", 643509.7621363, 9417892.0424743, -79.705, -5.265],
  ["29188", 500514.2773168, 7511819.7499811, -74.995, -22.5],
  ["29189", 500518.1607259, 7630807.0755607, -68.995, -21.425],
  ["29190", 500523.4888743, 7804003.3815382, -62.995, -19.86],
  ["29191", 500531.650374, 8098313.1805929, -56.995, -17.2],
  ["29192", 500539.1644881, 8415218.371387, -50.995, -14.335],
  ["29193", 500000.0, 8431808.0480999, -45.0, -14.185],
  ["29194", 500000.0, 8584423.552966, -39.0, -12.805],
  ["29195", 500548.3030765, 8916143.5317901, -32.995, -9.805],
];

describe('precision-grid overrides preserve EPSG projection coordinates (#7052)', () => {
  it('covers every curated override with an independent projection control', () => {
    assert.deepEqual(
      Object.keys(PRECISION_GRIDS).sort(),
      PROJECTION_CONTROLS.map(([code]) => code).sort(),
    );
  });

  for (const [code, easting, northing, longitude, latitude] of PROJECTION_CONTROLS) {
    it(`EPSG:${code} agrees with the independent PROJ control`, () => {
      const spec = PRECISION_GRIDS[code];
      assert.ok(spec, `missing audited precision-grid projection for EPSG:${code}`);
      const definition = spec.proj4.replace(/\+nadgrids=\S+/, '+nadgrids=null');
      const [actualLongitude, actualLatitude] = proj4(definition, 'EPSG:4326', [easting, northing]);
      // 1e-7 degree is roughly 1cm: catches wrong origin, zone, unit and
      // prime-meridian parameters while allowing minor series rounding.
      assert.ok(Math.abs(actualLongitude - longitude) < 1e-7, `${actualLongitude} != ${longitude}`);
      assert.ok(Math.abs(actualLatitude - latitude) < 1e-7, `${actualLatitude} != ${latitude}`);
    });
  }

  it('excludes CRSs whose source datum is incompatible with the curated grids (#7052)', () => {
    // EPSG:2007 is St Vincent 45; 320xx are US-foot State Plane systems.
    // EPSG:3763 is already ETRS89, and 5513 is not the source JTSK03 datum.
    for (const code of ['2007', '3763', '5513', ...Array.from({ length: 16 }, (_, i) => String(32007 + i))]) {
      // Table invariant: an incompatible CRS must have no override at all.
      // Testing resolvePrecisionDef returning null would be vacuous in Node,
      // where the loader deliberately skips network access for every grid.
      assert.equal(PRECISION_GRIDS[code], undefined, `EPSG:${code} must keep its own projection and datum`);
    }
  });
});

describe('precision grids validate source datums before registration (#7052)', () => {
  it('every grid accepts the actual bundled EPSG datum, including documented deprecated exceptions', async () => {
    // Independent PROJ 9.8 CRS metadata for the only two codes omitted by
    // the bundled registry. These exceptions must not grow implicitly.
    const deprecatedDatums: Readonly<Record<string, string>> = {
      '20248': 'AGD66', '20348': 'AGD84',
    };
    const missingCodes: string[] = [];
    for (const [code, spec] of Object.entries(PRECISION_GRIDS)) {
      const entry = await lookupEpsgByCode(code);
      if (!entry) missingCodes.push(code);
      const datum = entry?.datum ?? deprecatedDatums[code];
      assert.ok(datum, `EPSG:${code} has no independently audited datum`);
      // Reflect allows this regression oracle to run against the pre-fix
      // production module and fail an assertion, rather than a type/import error.
      const accepted = Reflect.get(spec, 'sourceDatums');
      assert.ok(Array.isArray(accepted), `${spec.filename} is missing source datum metadata`);
      assert.ok(accepted.includes(datum), `EPSG:${code} (${datum}) cannot use ${spec.filename}`);
    }
    assert.deepEqual(missingCodes.sort(), Object.keys(deprecatedDatums).sort());
  });

  it('rejects mismatched and unknown EPSG datums even when the grid is already loaded', async () => {
    // A real decoded and registered zero-shift grid prevents the Node
    // network-skip fallback from making this guard test pass vacuously.
    const grid = writeArrayBuffer(new Float32Array(8), {
      width: 2, height: 2, SamplesPerPixel: [2],
      ModelPixelScale: [2, 2, 0], ModelTiepoint: [0, 0, 0, 4, 54, 0],
      GeographicTypeGeoKey: 4326,
    });
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const testContext = process.env.NODE_TEST_CONTEXT;
    const warnings: string[] = [];
    let requests = 0;
    delete process.env.NODE_TEST_CONTEXT;
    globalThis.fetch = async () => {
      requests++;
      return new Response(grid, { status: 200 });
    };
    console.warn = (message: unknown) => { warnings.push(String(message)); };
    try {
      const valid = PRECISION_GRIDS['28992'];
      assert.equal(await resolvePrecisionDef('28992'), valid.proj4);
      assert.equal(hasLoadedPrecisionGrid('28992'), true);
      assert.equal(requests, 1);
      // ETRS89 is already the grid's target frame. A legacy-datum shift
      // would corrupt it, although proj4 can consume the loaded raster.
      for (const code of ['3763', '999999']) {
        const previous = PRECISION_GRIDS[code];
        PRECISION_GRIDS[code] = valid;
        try {
          assert.equal(await resolvePrecisionDef(code), null);
          assert.equal(await resolvePrecisionDef(code), null, 'repeated readouts remain rejected');
          assert.equal(warnings.filter(message => message.includes(`EPSG:${code}:`)).length, 1);
          assert.equal(hasLoadedPrecisionGrid(code), false);
          assert.equal(hasFailedPrecisionGrid(code), true);
          assert.equal(requests, 1, 'reject before attempting any grid load');
        } finally {
          if (previous) PRECISION_GRIDS[code] = previous;
          else delete PRECISION_GRIDS[code];
        }
      }
      assert.equal(hasLoadedPrecisionGrid('28992'), true, 'bad mapping must not poison a compatible CRS');
      assert.ok(warnings.some(message => message.includes('EPSG:3763') && message.includes('ETRS89')));
      assert.ok(warnings.some(message => message.includes('EPSG:999999') && message.includes('(unknown)')));
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = testContext;
    }
  });
});
