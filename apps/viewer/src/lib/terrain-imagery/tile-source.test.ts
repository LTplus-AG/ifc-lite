/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5942 — tile sources are placed exactly by construction (spec §15.1): an
 * XYZ mosaic is a rectangle of the EPSG:3857 grid, a WMS image is requested
 * in the terrain's own CRS. Values below are checkable by hand.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateTileSource, wmsRequest, xyzPlacement, xyzTileRange, xyzTileUrl } from './tile-source.js';

describe('XYZ tiles (#5942)', () => {
  it('finds the tiles over a longitude/latitude box', () => {
    // Zoom 1 splits the world in 2 × 2; a box in the north-east quadrant is tile (1, 0).
    assert.deepEqual(xyzTileRange([10, 10, 20, 20], 1), { zoom: 1, xMin: 1, xMax: 1, yMin: 0, yMax: 0 });
    // Bern (7.44° E, 46.95° N) at zoom 16: x = floor((7.44 + 180) / 360 · 65 536) = 34 122.
    const bern = xyzTileRange([7.4395, 46.9510, 7.4400, 46.9515], 16);
    assert.equal(bern.xMin, 34_122);
    assert.equal(bern.xMax, 34_122);
  });

  it('places a tile range exactly in EPSG:3857', () => {
    // Zoom 0 is one 256 px tile spanning ±20 037 508.34 m.
    const world = xyzPlacement({ zoom: 0, xMin: 0, xMax: 0, yMin: 0, yMax: 0 });
    assert.equal(world.crs, 'EPSG:3857');
    assert.deepEqual([world.width, world.height], [256, 256]);
    assert.equal(world.affine.c, -20_037_508.342789244);
    assert.equal(world.affine.f, 20_037_508.342789244);
    assert.equal(world.affine.a * 256, 2 * 20_037_508.342789244);
    assert.equal(world.placement, 'tiles');
    // Tile (1, 0) at zoom 1 starts at the prime meridian.
    assert.equal(xyzPlacement({ zoom: 1, xMin: 1, xMax: 1, yMin: 0, yMax: 0 }).affine.c, 0);
  });

  it('fills the template and validates it', () => {
    assert.equal(xyzTileUrl('https://t.example/{z}/{x}/{y}.png', 3, 4, 5), 'https://t.example/3/4/5.png');
    assert.match(validateTileSource({ kind: 'xyz', urlTemplate: 'https://t.example/{z}/{x}.png', zoom: 3 }) ?? '', /\{y\}/);
    assert.match(validateTileSource({ kind: 'xyz', urlTemplate: 'ftp://t.example/{z}/{x}/{y}', zoom: 3 }) ?? '', /http/);
    assert.equal(validateTileSource({ kind: 'xyz', urlTemplate: 'https://t.example/{z}/{x}/{y}', zoom: 3 }), null);
  });
});

describe('WMS (#5942)', () => {
  it('requests WMS 1.1.1 in the terrain CRS with an easting-first bounding box', () => {
    const request = wmsRequest(
      { kind: 'wms', url: 'https://wms.example/service?token=a', layers: 'ortho', resolution: 0.5 },
      'EPSG:2056', [2_600_000, 1_200_000, 2_600_100, 1_200_050],
    );
    assert.ok(request.ok);
    const url = new URL(request.value.url);
    assert.equal(url.searchParams.get('VERSION'), '1.1.1');
    assert.equal(url.searchParams.get('SRS'), 'EPSG:2056');
    // WMS 1.1.1 is always x, y = easting, northing — never the CRS's axis order.
    assert.equal(url.searchParams.get('BBOX'), '2600000,1200000,2600100,1200050');
    assert.equal(url.searchParams.get('WIDTH'), '200');
    assert.equal(url.searchParams.get('HEIGHT'), '100');
    assert.equal(url.searchParams.get('token'), 'a');
    assert.deepEqual(request.value.placement.affine, { a: 0.5, b: 0, d: 0, e: -0.5, c: 2_600_000, f: 1_200_050 });
  });

  it('refuses a request larger than the texture budget instead of truncating it', () => {
    const request = wmsRequest({ kind: 'wms', url: 'https://wms.example/', layers: 'o', resolution: 0.01 }, 'EPSG:2056', [0, 0, 100, 100]);
    assert.equal(request.ok, false);
  });
});
