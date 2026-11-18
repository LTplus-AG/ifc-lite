/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The public contract beyond positions: engines do not share what they
 * resolved, a transformer's datum-shift verdict is about the definition it
 * holds, the native unit is reported while coordinates stay metres, both
 * directions refuse alike, and the package is silent unless asked to talk.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeArrayBuffer } from 'geotiff';

import {
  configureCrsDiagnostics,
  configureCrsLoaders,
  createCrsEngine,
  resolveCrs,
  type GridFileLoader,
} from './index.js';
import { hasFailedPrecisionGrid, hasLoadedPrecisionGrid } from './precision-grids.js';

const UTM32 = '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs';

/** A real, decodable two-band zero-shift grid: proj4 accepts it as RD New's grid. */
function zeroGrid(): ArrayBuffer {
  return writeArrayBuffer(new Float32Array(8), {
    width: 2, height: 2, SamplesPerPixel: [2],
    ModelPixelScale: [2, 2, 0], ModelTiepoint: [0, 0, 0, 4, 54, 0],
    GeographicTypeGeoKey: 4326,
  }) as ArrayBuffer;
}

describe('engines keep what they resolved to themselves', () => {
  it('drops a definition from a previous loader when the loaders are replaced', async () => {
    // Reproduction from review: configureCrsLoaders({}) left the definition
    // the previous epsgDefinition loader fetched in the shared cache.
    const previous = configureCrsLoaders({ epsgDefinition: async () => UTM32 });
    try {
      assert.ok(await resolveCrs({ epsg: 999991 }), 'resolved through the loader');
      configureCrsLoaders({});
      assert.equal(await resolveCrs({ epsg: 999991 }), null, 'no loader, no definition');
    } finally {
      configureCrsLoaders(previous);
    }
  });

  it('does not let an engine see the default engine\'s definitions, or the reverse', async () => {
    const asked: string[] = [];
    const engine = createCrsEngine({
      loaders: { epsgDefinition: async (code) => { asked.push(code); return UTM32; } },
    });
    assert.ok(await engine.resolveCrs({ epsg: 999992 }));
    assert.equal(await resolveCrs({ epsg: 999992 }), null, 'nothing leaks out of the engine');

    const previous = configureCrsLoaders({ epsgDefinition: async () => UTM32 });
    try {
      assert.ok(await resolveCrs({ epsg: 999993 }));
      const isolated = createCrsEngine();
      assert.equal(await isolated.resolveCrs({ epsg: 999993 }), null, 'nothing leaks into an engine');
    } finally {
      configureCrsLoaders(previous);
    }
    assert.deepEqual(asked, ['999992']);
  });

  it('keeps a grid an engine loaded out of the default engine, and out of proj4\'s shared name', async () => {
    let requests = 0;
    const gridFile: GridFileLoader = async () => { requests++; return zeroGrid(); };
    const engine = createCrsEngine({ loaders: { gridFile } });
    const withGrid = await engine.resolveCrs({ epsg: 28992 });
    assert.ok(withGrid);
    assert.equal(withGrid.datumShift, 'as-defined');
    assert.equal(requests, 1);
    assert.match(withGrid.definition, /\+nadgrids=\S+~engine\d+/, 'registered under a name of its own');

    const byDefault = await resolveCrs({ epsg: 28992 });
    assert.equal(byDefault?.datumShift, 'helmert-approximation', 'the default engine has no grid loader');
    assert.equal(hasLoadedPrecisionGrid('28992'), false);

    // The engine keeps its grid: a second resolution makes no request.
    assert.equal((await engine.resolveCrs({ name: 'RD New' }))?.datumShift, 'as-defined');
    assert.equal(requests, 1);
  });
});

describe('datumShift describes the definition the transformer holds', () => {
  it('reports a datum shift the WKT states as defined, even for a code whose own shift is approximate', async () => {
    // EPSG:28992 without its grid is a Helmert approximation, but this WKT
    // states its own TOWGS84, which replaces it. The verdict used to be read
    // from a per-code record and said `helmert-approximation`.
    const wkt = 'PROJCS["Amersfoort / RD New",GEOGCS["Amersfoort",DATUM["Amersfoort",SPHEROID["Bessel 1841",6377397.155,299.1528128],'
      + 'TOWGS84[565.2369,50.0087,465.658,-0.406857,0.350733,-1.87035,4.0812]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],'
      + 'PROJECTION["Oblique_Stereographic"],PARAMETER["latitude_of_origin",52.15616055555555],PARAMETER["central_meridian",5.38763888888889],'
      + 'PARAMETER["scale_factor",0.9999079],PARAMETER["false_easting",155000],PARAMETER["false_northing",463000],UNIT["metre",1],AUTHORITY["EPSG","28992"]]';
    const crs = await resolveCrs({ wkt });
    assert.ok(crs);
    assert.equal(crs.epsg, 28992);
    assert.equal(crs.datumShift, 'as-defined');
    assert.equal((await resolveCrs({ epsg: 28992 }))?.datumShift, 'helmert-approximation');
  });

  it('keeps an approximate verdict after the same engine later loads the grid', async () => {
    let available = false;
    const engine = createCrsEngine({ loaders: { gridFile: async () => (available ? zeroGrid() : null) } });
    const before = await engine.resolveCrs({ epsg: 28992 });
    available = true;
    const after = await engine.resolveCrs({ epsg: 28992 });
    assert.equal(after?.datumShift, 'as-defined');
    assert.equal(before?.datumShift, 'helmert-approximation');
    assert.doesNotMatch(before?.definition ?? '', /\+nadgrids=/);
  });
});

describe('units', () => {
  it('reports a US survey foot CRS\'s unit while taking and returning metres', async () => {
    // NAD83 / California zone 3 (ftUS): false origin 6,561,666.667 ftUS E,
    // 1,640,416.667 ftUS N at 36.5 N, 120.5 W.
    const crs = await resolveCrs({ epsg: 2227 });
    assert.ok(crs);
    assert.deepEqual(crs.linearUnit, { name: 'US survey foot', toMetres: 1200 / 3937 });
    const { toMetres } = crs.linearUnit;
    const origin = crs.toWgs84([6561666.667 * toMetres, 1640416.667 * toMetres]);
    assert.ok(origin && Math.abs(origin[0] + 120.5) < 1e-7 && Math.abs(origin[1] - 36.5) < 1e-7, `${origin}`);
    const back = crs.fromWgs84([-120.5, 36.5]);
    assert.ok(back && Math.abs(back[0] / toMetres - 6561666.667) < 1e-3 && Math.abs(back[1] / toMetres - 1640416.667) < 1e-3, `${back}`);
    assert.deepEqual((await resolveCrs({ epsg: 32632 }))?.linearUnit, { name: 'metre', toMetres: 1 });
    assert.equal((await resolveCrs({ epsg: 4326 }))?.linearUnit, null);
  });
});

describe('fromWgs84 refuses what toWgs84 refuses', () => {
  it('refuses a position outside the extent the WKT declares, in both directions', async () => {
    const wkt = 'PROJCRS["ETRS89 / UTM zone 33N",ID["EPSG",25833],USAGE[SCOPE["x"],AREA["x"],BBOX[52.0,12.5,52.8,14.0]]]';
    const crs = await resolveCrs({ wkt });
    assert.ok(crs);
    assert.ok(crs.fromWgs84([13.4, 52.5]), 'inside');
    assert.ok(crs.toWgs84([390000, 5800000]), 'inside');
    assert.equal(crs.toWgs84([500000, 5300000]), null, 'Bavaria is outside');
    assert.equal(crs.fromWgs84([15, 47.8]), null, 'and so is its WGS84 position');
  });
});

describe('diagnostics', () => {
  it('are silent by default and go to the installed handler', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    assert.equal(await resolveCrs({ wkt: 'PROJCRS["no conversion at all"' }), null);
    assert.equal(warn.mock.callCount(), 0, 'the package writes nothing to the console');

    const messages: string[] = [];
    const previous = configureCrsDiagnostics((message) => { messages.push(message); });
    try {
      assert.equal(await resolveCrs({ wkt: 'VERTCRS["height only"]' }), null);
    } finally {
      configureCrsDiagnostics(previous);
    }
    assert.ok(messages.some((message) => message.includes('no horizontal CRS')), messages.join('\n'));
    assert.equal(warn.mock.callCount(), 0);
  });
});

describe('replacing the loaders while a grid is loading', () => {
  it('does not let the old loader\'s late failure block the new loader (#10385 review)', async () => {
    let rejectOld: ((error: Error) => void) | undefined;
    const previous = configureCrsLoaders({
      gridFile: () => new Promise<ArrayBuffer | null>((_, reject) => { rejectOld = reject; }),
    });
    const previousDiagnostics = configureCrsDiagnostics(null);
    try {
      const pending = resolveCrs({ epsg: 28992 });
      for (let turn = 0; !rejectOld && turn < 1000; turn++) await new Promise((resolve) => setTimeout(resolve, 1));
      assert.ok(rejectOld, 'the first loader was asked for the grid');

      let requests = 0;
      configureCrsLoaders({ gridFile: async () => { requests++; return zeroGrid(); } });
      rejectOld(new Error('network gone'));
      assert.equal((await pending)?.datumShift, 'helmert-approximation');

      const crs = await resolveCrs({ epsg: 28992 });
      assert.equal(requests, 1, 'the new loader is asked');
      assert.equal(crs?.datumShift, 'as-defined');
    } finally {
      configureCrsLoaders(previous);
      configureCrsDiagnostics(previousDiagnostics);
    }
  });
});

describe('a transformer keeps its grid when the default engine is reconfigured (#10385 review)', () => {
  it('is not switched to grid bytes a later loader returns for the same file', async () => {
    const shifted = (): ArrayBuffer => writeArrayBuffer(new Float32Array(8).fill(10), {
      width: 2, height: 2, SamplesPerPixel: [2],
      ModelPixelScale: [2, 2, 0], ModelTiepoint: [0, 0, 0, 4, 54, 0],
      GeographicTypeGeoKey: 4326,
    }) as ArrayBuffer;
    const previous = configureCrsLoaders({ gridFile: async () => zeroGrid() });
    try {
      const first = await resolveCrs({ epsg: 28992 });
      assert.equal(first?.datumShift, 'as-defined');
      const before = first.toWgs84([155000, 463000]);
      configureCrsLoaders({ gridFile: async () => shifted() });
      const second = await resolveCrs({ epsg: 28992 });
      assert.equal(second?.datumShift, 'as-defined');
      const moved = second.toWgs84([155000, 463000]);
      assert.ok(before && moved && Math.abs(moved[0] - before[0]) > 1e-4, 'the second grid really shifts');
      assert.deepEqual(first.toWgs84([155000, 463000]), before, 'the earlier transformer kept its own grid');
    } finally {
      configureCrsLoaders(previous);
    }
  });
});

describe('a non-finite height (#10385 review)', () => {
  it('is refused in both directions, like a non-finite x or y', async () => {
    const crs = await resolveCrs({ epsg: 32632 });
    assert.ok(crs);
    assert.equal(crs.toWgs84([500000, 5200000, Number.NaN]), null);
    assert.equal(crs.fromWgs84([9, 47, Number.POSITIVE_INFINITY]), null);
    assert.equal((await resolveCrs({ epsg: 4326 }))?.toWgs84([8, 47, Number.NaN]), null);
  });
});

describe('a grid the loader reports as not available (#10385 review)', () => {
  it('reads as failed instead of loading, and is asked for again on the next resolution', async () => {
    let available = false;
    let requests = 0;
    const previous = configureCrsLoaders({ gridFile: async () => { requests++; return available ? zeroGrid() : null; } });
    try {
      assert.equal((await resolveCrs({ epsg: 28992 }))?.datumShift, 'helmert-approximation');
      assert.equal(hasFailedPrecisionGrid('28992'), true, 'the badge stops at failed, not loading');
      available = true;
      assert.equal((await resolveCrs({ epsg: 28992 }))?.datumShift, 'as-defined');
      assert.equal(requests, 2, 'a null answer is retried');
      assert.equal(hasFailedPrecisionGrid('28992'), false);
      assert.equal(hasLoadedPrecisionGrid('28992'), true);
    } finally {
      configureCrsLoaders(previous);
    }
  });
});
