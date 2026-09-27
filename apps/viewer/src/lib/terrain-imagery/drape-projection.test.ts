/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5942 — the planar drape projection (mapping spec §15.3), at coordinates a
 * reader can check by hand. Every expected value below is derived in the
 * comment beside it from the placement, not read back from the code.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { drapeProjection, drapeUv, groundSampleDistance, uvCovered, type DrapeProjection } from './drape-projection.js';
import { geoTiffAffine, geoTiffCrs, parseWorldFile, type GeoRasterPlacement } from './georaster.js';
import { FEATURE, ORTHO, orthoWorldFile } from './synthetic-orthophoto.fixture.js';

function placed(affine: GeoRasterPlacement['affine'], width: number, height: number, crs = 'EPSG:2056'): GeoRasterPlacement {
  return { width, height, affine, crs, crsSource: 'test', placement: 'world file' };
}

function project(placement: GeoRasterPlacement, crs = 'EPSG:2056', transform?: (x: number, y: number) => [number, number]): DrapeProjection {
  const result = drapeProjection(placement, crs, transform);
  assert.ok(result.ok, result.ok ? '' : result.reason);
  return result.value;
}

/** The pixel (col, row) a plan position drapes, from its UV. */
function pixelOf(projection: DrapeProjection, easting: number, northing: number): [number, number] {
  const [u, v] = drapeUv(projection, easting, northing);
  return [Math.floor(u * projection.imageSize[0]), Math.floor((1 - v) * projection.imageSize[1])];
}

describe('world file placement (#5942)', () => {
  it('normalises the world file\'s pixel-CENTRE reference to the corner — the half-pixel trap', () => {
    const parsed = parseWorldFile(orthoWorldFile());
    assert.ok(parsed.ok);
    // C = 2 600 000.25 names the centre of pixel (0, 0); its corner is half a
    // 0.5 m pixel west of that, and F likewise half a pixel north.
    assert.equal(parsed.value.c, ORTHO.upperLeftCorner[0]);
    assert.equal(parsed.value.f, ORTHO.upperLeftCorner[1]);
    assert.deepEqual([parsed.value.a, parsed.value.b, parsed.value.d, parsed.value.e], [0.5, 0, 0, -0.5]);
  });

  it('refuses a world file that is short, non-numeric or degenerate', () => {
    assert.equal(parseWorldFile('0.5\n0\n0\n-0.5\n2600000').ok, false);
    assert.equal(parseWorldFile('0.5\n0\n0\nx\n2600000\n1200000').ok, false);
    assert.equal(parseWorldFile('0.5\n0.5\n0.5\n0.5\n2600000\n1200000').ok, false);
  });
});

describe('the planar projection at known coordinates (#5942)', () => {
  const parsed = parseWorldFile(orthoWorldFile());
  assert.ok(parsed.ok);
  const north = project(placed(parsed.value, ORTHO.width, ORTHO.height));

  it('puts the origin at the bottom-left corner with east/north axes and the image extent', () => {
    // Bottom-left corner: E 2 600 000, N 1 200 050 − 100 px · 0.5 m = 1 200 000.
    assert.deepEqual(north.origin, [2_600_000, 1_200_000]);
    assert.deepEqual(north.axisU, [1, 0]);
    assert.deepEqual(north.axisV, [0, 1]);
    assert.deepEqual(north.extent, [100, 50]);
    assert.deepEqual(groundSampleDistance(north), [0.5, 0.5]);
    assert.equal(north.deviationPx, 0);
  });

  it('maps the image\'s corners and centre to UV 0, 1 and ½ with the bottom-left texture origin', () => {
    assert.deepEqual(drapeUv(north, 2_600_000, 1_200_000), [0, 0]);
    assert.deepEqual(drapeUv(north, 2_600_100, 1_200_050), [1, 1]);
    assert.deepEqual(drapeUv(north, 2_600_050, 1_200_025), [0.5, 0.5]);
  });

  it('drapes the feature vertex on the marked pixel, at its centre', () => {
    const [u, v] = drapeUv(north, FEATURE.easting, FEATURE.northing);
    // (137.5 / 200, 1 − 23.5 / 100): the centre of pixel (137, 23).
    assert.ok(Math.abs(u - 137.5 / 200) < 1e-12);
    assert.ok(Math.abs(v - (1 - 23.5 / 100)) < 1e-12);
    assert.deepEqual(pixelOf(north, FEATURE.easting, FEATURE.northing), [ORTHO.marked.col, ORTHO.marked.row]);
  });

  it('calls a vertex outside the extent uncovered', () => {
    assert.equal(uvCovered(...drapeUv(north, 2_599_990, 1_200_020)), false);
    assert.equal(uvCovered(...drapeUv(north, 2_600_020, 1_199_990)), false);
    assert.equal(uvCovered(...drapeUv(north, 2_600_020, 1_200_020)), true);
  });

  it('handles a rotated world file exactly (30°), with no deviation', () => {
    const angle = Math.PI / 6;
    const gsd = 0.25;
    // Columns point 30° north of east; rows point 30° east of south.
    const affine = {
      a: gsd * Math.cos(angle), d: gsd * Math.sin(angle),
      b: gsd * Math.sin(angle), e: -gsd * Math.cos(angle),
      c: 2_600_000, f: 1_200_000,
    };
    const rotated = project(placed(affine, 400, 300));
    assert.ok(rotated.deviationPx < 1e-6);
    // The centre of pixel (250, 100), by the affine: x = a·250.5 + b·100.5 + c.
    const x = affine.a * 250.5 + affine.b * 100.5 + affine.c;
    const y = affine.d * 250.5 + affine.e * 100.5 + affine.f;
    assert.deepEqual(pixelOf(rotated, x, y), [250, 100]);
  });

  it('refuses a skewed world file, naming the measured deviation', () => {
    // Rows lean 2 % sideways: across 1000 rows the far corner is 20 px off.
    const result = drapeProjection(placed({ a: 1, b: 0.02, c: 0, d: 0, e: -1, f: 0 }, 1000, 1000), 'EPSG:2056');
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /not planar in EPSG:2056 to within half a pixel: .* by \d+\.\d\d px/);
  });
});

describe('GeoTIFF placement (#5942)', () => {
  const tie = [0, 0, 0, 2_600_000, 1_200_050, 0];
  const scale = [0.5, 0.5, 0];

  it('reads a PixelIsArea tie point as the corner, and a PixelIsPoint one as the centre', () => {
    const area = geoTiffAffine({ ModelTiepoint: tie, ModelPixelScale: scale, rasterType: 1 });
    const point = geoTiffAffine({ ModelTiepoint: tie, ModelPixelScale: scale, rasterType: 2 });
    assert.ok(area.ok && point.ok);
    assert.deepEqual(area.value, { a: 0.5, b: 0, d: 0, e: -0.5, c: 2_600_000, f: 1_200_050 });
    // The same numbers, naming a pixel centre, put the corner half a pixel
    // west and north: 2 599 999.75, 1 200 050.25.
    assert.equal(point.value.c, 2_599_999.75);
    assert.equal(point.value.f, 1_200_050.25);
  });

  it('agrees with the equivalent world file', () => {
    const tiff = geoTiffAffine({ ModelTiepoint: tie, ModelPixelScale: scale });
    const world = parseWorldFile(orthoWorldFile());
    assert.ok(tiff.ok && world.ok);
    assert.deepEqual(tiff.value, world.value);
  });

  it('refuses ground-control-point warps and a missing geotransform', () => {
    assert.equal(geoTiffAffine({ ModelTiepoint: [...tie, 10, 10, 0, 2_600_005, 1_200_045, 0] }).ok, false);
    assert.equal(geoTiffAffine({}).ok, false);
  });

  it('reads an EPSG code from the GeoKeys and refuses user-defined or unkeyed CRSs', () => {
    assert.equal(geoTiffCrs({ GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 2056 }), 'EPSG:2056');
    assert.equal(geoTiffCrs({ GTModelTypeGeoKey: 2, GeographicTypeGeoKey: 4326 }), 'EPSG:4326');
    assert.equal(geoTiffCrs({ GTModelTypeGeoKey: 1, ProjectedCSTypeGeoKey: 32767, GeographicTypeGeoKey: 4326 }), null);
    assert.equal(geoTiffCrs({}), null);
  });
});

describe('an image in another CRS (#5942)', () => {
  proj4.defs('EPSG:2056', '+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs');
  const toLv95 = (x: number, y: number) => proj4('EPSG:3857', 'EPSG:2056', [x, y]) as [number, number];
  const bern = proj4('EPSG:2056', 'EPSG:3857', [2_600_000, 1_200_000]) as [number, number];

  it('fits a planar projection in the terrain CRS when the reprojection is flat to half a pixel', () => {
    // A 512 px Web Mercator image at ~0.3 m over Bern: the curvature of the
    // Mercator → Swiss oblique Mercator operation across 150 m is far below a pixel.
    const image = placed({ a: 0.3, b: 0, c: bern[0], d: 0, e: -0.3, f: bern[1] }, 512, 512, 'EPSG:3857');
    const projection = project(image, 'EPSG:2056', toLv95);
    assert.ok(projection.deviationPx < 0.05, `deviation ${projection.deviationPx}`);
    // Web Mercator stretches by sec(φ) ≈ 1.46 at 46.95° N, so a 0.3 m
    // Mercator pixel covers ~0.205 m on the ground in LV95.
    const [gsdU] = groundSampleDistance(projection);
    assert.ok(Math.abs(gsdU - 0.3 / 1.4635) < 0.002, `gsd ${gsdU}`);
  });

  it('refuses when the reprojection curves more than half a pixel over the image', () => {
    // The same 0.3 m pixel over 60 km: curvature is metres, pixels are 30 cm.
    const image = placed({ a: 0.3, b: 0, c: bern[0], d: 0, e: -0.3, f: bern[1] }, 200_000, 200_000, 'EPSG:3857');
    const result = drapeProjection(image, 'EPSG:2056', toLv95);
    assert.equal(result.ok, false);
  });
});

describe('the coordinate-order trap (#5942, spec §15.3)', () => {
  // A 100 × 100 px image at 1 m over E 1000–1100, N 1000–1100 — a grid near
  // the line easting = northing, so a transposed position still falls on the
  // image and the mirror is visible rather than merely "off the map".
  const image = placed({ a: 1, b: 0, c: 1000, d: 0, e: -1, f: 1100 }, 100, 100);
  const projection = project(image);
  // Marked pixel (70, 20): its centre is E 1070.5, N 1079.5.
  const marked: [number, number] = [70, 20];
  const feature = { easting: 1070.5, northing: 1079.5 };

  it('drapes a northing-first vertex on the marked pixel', () => {
    assert.deepEqual(pixelOf(projection, feature.easting, feature.northing), marked);
  });

  it('drapes the same vertex from an easting-first producer on the MIRRORED pixel', () => {
    // An easting-first producer writes "1070.5 1079.5"; LandXML reads the
    // first number as the northing. The drape takes the vertex as the reader
    // gave it and never reorders the image, so the feature lands at
    // E 1079.5, N 1070.5 — pixel (79, 29), the reflection across E = N.
    const read = { northing: 1070.5, easting: 1079.5 };
    const pixel = pixelOf(projection, read.easting, read.northing);
    assert.deepEqual(pixel, [79, 29]);
    assert.notDeepEqual(pixel, marked);
  });
});
