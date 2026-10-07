/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { writeArrayBuffer } from 'geotiff';
import { hasLoadedPrecisionGrid } from './precision-grids.js';
import { reprojectPointToLatLon, resolveProjection } from './reproject.js';

it('CRS aliases load precision operations before bundled Helmert fallback (#7058)', async () => {
  // A real two-band GeoTIFF containing a constant horizontal shift. This
  // exercises geotiff decoding and proj4 registration without network access.
  // At RD's false origin, the Bessel longitude/latitude is exactly the
  // projection lat_0/lon_0. A zero grid preserves those angles; the bundled
  // Helmert yields a different coordinate, so fallback cannot satisfy this.
  const grid = writeArrayBuffer(new Float32Array(8), {
    width: 2, height: 2, SamplesPerPixel: [2],
    ModelPixelScale: [2, 2, 0], ModelTiepoint: [0, 0, 0, 4, 54, 0],
    GeographicTypeGeoKey: 4326,
  });
  const originalFetch = globalThis.fetch;
  const testContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(grid, { status: 200 });
  };
  try {
    const result = await reprojectPointToLatLon(155000, 463000, {
      id: 1, name: 'Amersfoort / RD New', mapUnitScale: 1,
    });
    assert.ok(result);
    assert.equal(requests, 1);
    assert.ok(hasLoadedPrecisionGrid('28992'));
    assert.ok(Math.abs(result.lon - 5.38763888888889) < 1e-8, `${result.lon}`);
    assert.ok(Math.abs(result.lat - 52.15616055555555) < 1e-8, `${result.lat}`);
    const explicit = await reprojectPointToLatLon(155000, 463000, {
      id: 1, name: 'EPSG:28992', mapUnitScale: 1,
    });
    assert.deepEqual(explicit, result);
    assert.equal(requests, 1, 'alias and explicit code share the registered operation');
    const outsideGrid = await reprojectPointToLatLon(0, 0, {
      id: 1, name: 'Amersfoort / RD New', mapUnitScale: 1,
    });
    assert.equal(outsideGrid, null, 'a registered grid must refuse points outside its coverage');
  } finally {
    globalThis.fetch = originalFetch;
    if (testContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = testContext;
  }
});

it('WGS84 UTM metadata does not poison geographic resolution (#7058)', async () => {
  await resolveProjection({ id: 1, name: 'WGS 84' });
  const utm = await reprojectPointToLatLon(500000, 0, { id: 1, name: 'WGS 84', mapZone: '32N' });
  assert.ok(utm);
  assert.ok(Math.abs(utm.lon - 9) < 1e-8);
  assert.ok(Math.abs(utm.lat) < 1e-8);
  const geographic = await reprojectPointToLatLon(5, 52, { id: 1, name: 'EPSG:4326' });
  assert.deepEqual(geographic, { lon: 5, lat: 52 });
});

// Independent pyproj 3.8 / PROJ 9.8 controls at (500000, 4500000),
// always_xy=True. NAD27 uses the documented -8,160,176 Helmert fallback;
// regional NAD83/ETRS89 frames use the existing WGS84 approximation.
for (const control of [
  { name: 'NAD83', geographic: '4269', zone: '18N', lon: -75, lat: 40.65085651660554 },
  { name: 'NAD27', geographic: '4267', zone: '18N', lon: -74.9996017291521, lat: 40.65276437347483 },
  { name: 'ETRS89', geographic: '4258', zone: '32N', lon: 9, lat: 40.65085651660554 },
]) {
  it(`${control.name} UTM retains its datum in both geographic cache orders (#7058)`, async () => {
    const geographicCrs = { id: 1, name: `EPSG:${control.geographic}` };
    // Projected-first must leave the geographic definition uncontaminated.
    const first = await reprojectPointToLatLon(500000, 4500000, {
      id: 1, name: control.name, mapZone: control.zone,
    });
    assert.ok(first);
    assert.ok(Math.abs(first.lon - control.lon) < 1e-7, `${first.lon}`);
    assert.ok(Math.abs(first.lat - control.lat) < 1e-7, `${first.lat}`);
    assert.match((await resolveProjection(geographicCrs)) ?? '', /\+proj=longlat\b/);
    // Geographic-first must still honor zone metadata on the next resolution.
    for (const metadata of [
      { mapZone: '', mapProjection: `UTM zone ${control.zone}` },
      { mapZone: '61N', description: `UTM zone ${control.zone}` },
    ]) {
      const second = await reprojectPointToLatLon(500000, 4500000, {
        id: 1, name: control.name, ...metadata,
      });
      assert.deepEqual(second, first);
    }
    assert.match((await resolveProjection(geographicCrs)) ?? '', /\+proj=longlat\b/);
  });
}
