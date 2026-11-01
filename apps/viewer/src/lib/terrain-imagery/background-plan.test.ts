/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fromArrayBuffer } from 'geotiff';
import proj4 from 'proj4';
import { spatialReferenceFromIfc } from '@/lib/geo/ifc-spatial-reference';
import { planOrthophotoBackground, sampleBackgroundRow, type BackgroundPlan } from './background-plan';
import { geoTiffAffine, type GeoRasterPlacement } from './georaster';

const reference = (rotation = 0, scale = 1) => spatialReferenceFromIfc({
  mapConversion: { id: 1, sourceCRS: 1, targetCRS: 2, eastings: 500000, northings: 6000000,
    orthogonalHeight: 100, scale, xAxisAbscissa: Math.cos(rotation), xAxisOrdinate: Math.sin(rotation) },
  projectedCRS: { id: 2, name: 'EPSG:32632', mapUnitScale: 1 }, lengthUnitScale: 1,
});
const raster: GeoRasterPlacement = { width: 100, height: 80,
  affine: { a: 1, b: 0, c: 500000, d: 0, e: -1, f: 6000080 },
  crs: 'EPSG:32632', crsSource: 'GeoKeys', placement: 'GeoTIFF' };
const identity = { forward: (p: readonly [number, number]) => p, inverse: (p: readonly [number, number]) => p };
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

// #8552 / discussion #8294: inverse sampling must place pixel centres exactly,
// including negative north/south, IFC rotation, scale and large map offsets.
test('orthophoto pixel landmarks agree with IFC engineering coordinates (#8552)', () => {
  for (const angle of [0, Math.PI / 2, 0.37]) for (const scale of [1, 2]) {
    const plan = planOrthophotoBackground(raster, reference(angle, scale), identity, -3);
    assert.ok(plan.corners.every(p => p[2] === -3));
    for (const [col, row] of [[0, 0], [10, 20], [50, 40]]) {
      const [minX, maxY] = plan.corners[0];
      const x = minX + (col + 0.5) / plan.width * (plan.corners[1][0] - minX);
      const y = maxY + (row + 0.5) / plan.height * (plan.corners[3][1] - maxY);
      const [px, py] = plan.sourcePixel(col, row);
      near(px, scale * (Math.cos(angle) * x - Math.sin(angle) * y));
      near(py, 80 - scale * (Math.sin(angle) * x + Math.cos(angle) * y));
    }
  }
});

test('orthophoto inverse warp preserves nonlinear reprojection rather than interpolating corners (#8552)', () => {
  const projection = {
    forward: ([x, y]: readonly [number, number]): [number, number] => [x, y + (x - 500000) ** 2 / 100],
    inverse: ([x, y]: readonly [number, number]): [number, number] => [x, y - (x - 500000) ** 2 / 100],
  };
  const plan = planOrthophotoBackground(raster, reference(), projection, 0);
  const [x0, y0] = plan.corners[0];
  const col = plan.width / 2, row = plan.height / 2;
  const x = x0 + (col + 0.5) / plan.width * (plan.corners[1][0] - x0);
  const y = y0 + (row + 0.5) / plan.height * (plan.corners[3][1] - y0);
  const [px, py] = plan.sourcePixel(col, row);
  near(px, x); near(py, 80 - y + x * x / 100);
});

test('orthophoto sampling preserves alpha and leaves outside coverage transparent (#8552)', () => {
  const plan: BackgroundPlan = { width: 3, height: 1, corners: [[0,0,0],[1,0,0],[1,1,0],[0,1,0]],
    sourcePixel: col => [col === 0 ? -1 : col === 1 ? 1 : 0.5, 0.5] };
  const output = new Uint8ClampedArray(12);
  sampleBackgroundRow(plan, 0, new Uint8ClampedArray([255,0,0,255,0,0,255,0]), 2, 1, 2, 1, output);
  assert.deepEqual([...output], [0,0,0,0,255,0,0,128,255,0,0,255]);
});

test('orthophoto rejects invalid transforms and bounds output allocation (#8552)', () => {
  assert.throws(() => planOrthophotoBackground({ ...raster, affine: { ...raster.affine, a: 0 } }, reference(), identity, 0), /invalid/);
  assert.throws(() => planOrthophotoBackground(raster, reference(0, 0), identity, 0), /transformation/);
  const plan = planOrthophotoBackground({ ...raster, width: 20000, height: 10000 }, reference(), identity, 0);
  assert.ok(plan.width <= 2048 && plan.height <= 2048);
});

const path = resolve(process.cwd(), '../../tests/models/landxml/imagery/nls-orthophoto-2022-m3143g-sw-road.tif');
test('real NLS orthophoto retains its half-metre pixel centre and road colour (#8552)', {
  skip: !existsSync(path) && 'Run pnpm fixtures for the NLS orthophoto.',
}, async () => {
  const bytes = readFileSync(path);
  const image = await (await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).getImage();
  const affine = geoTiffAffine({ ModelTiepoint: Array.from(image.fileDirectory.ModelTiepoint ?? []), ModelPixelScale: Array.from(image.fileDirectory.ModelPixelScale ?? []) });
  assert.ok(affine.ok);
  const real = { ...raster, width: image.getWidth(), height: image.getHeight(), affine: affine.value, crs: 'EPSG:3067' };
  const ref = spatialReferenceFromIfc({ mapConversion: { id: 1, sourceCRS: 1, targetCRS: 2, eastings: 207460, northings: 6791800, orthogonalHeight: 0, scale: 1 },
    projectedCRS: { id: 2, name: 'EPSG:3067', mapUnitScale: 1 }, lengthUnitScale: 1 });
  const plan = planOrthophotoBackground(real, ref, identity, 0, 322);
  // One-pixel margin: source pixel (100,100) remains at output (101,101).
  const [x, y] = plan.sourcePixel(101, 101);
  near(x, 100.5); near(y, 100.5);
  const rgb = await image.readRGB({ interleave: true });
  const rgba = new Uint8ClampedArray(real.width * real.height * 4);
  for (let i = 0; i < real.width * real.height; i++) rgba.set([rgb[i*3], rgb[i*3+1], rgb[i*3+2], 255], i*4);
  const out = new Uint8ClampedArray(plan.width * plan.height * 4);
  sampleBackgroundRow(plan, 101, rgba, real.width, real.height, real.width, real.height, out);
  assert.deepEqual(out.slice((101 * plan.width + 101) * 4, (101 * plan.width + 102) * 4), rgba.slice((100 * real.width + 100) * 4, (100 * real.width + 101) * 4));
});

test('real survey landmark agrees with independent PROJ reference across Finnish CRSs (#8552)', () => {
  // 3D-Win M3 road point 17897; pyproj 3.8 / PROJ 9.8.1 oracle from
  // terrainImageryRealPair.test.tsx, not computed from this implementation.
  const transform = proj4('+proj=utm +zone=35 +ellps=GRS80 +units=m +no_defs',
    '+proj=tmerc +lat_0=0 +lon_0=21 +k=1 +x_0=21500000 +y_0=0 +ellps=GRS80 +units=m +no_defs');
  const ref = spatialReferenceFromIfc({ mapConversion: { id: 1, sourceCRS: 1, targetCRS: 2,
    eastings: 21530221.784398, northings: 6782568.793635, orthogonalHeight: 17.115599, scale: 1 },
    projectedCRS: { id: 2, name: 'EPSG:3875', mapUnitScale: 1 }, lengthUnitScale: 1 });
  const plan = planOrthophotoBackground({ ...raster, width: 320, height: 280,
    affine: { a: 0.5, b: 0, c: 207460, d: 0, e: -0.5, f: 6791940 } }, ref, {
    forward: p => transform.forward([...p]) as [number, number],
    inverse: p => transform.inverse([...p]) as [number, number],
  }, 0);
  // Query the output sample at the surveyed engineering origin.
  const col = -plan.corners[0][0] / (plan.corners[1][0] - plan.corners[0][0]) * plan.width - 0.5;
  const row = plan.corners[0][1] / (plan.corners[0][1] - plan.corners[3][1]) * plan.height - 0.5;
  const [px, py] = plan.sourcePixel(col, row);
  assert.ok(Math.abs(px - 45.5386) < 0.001);
  assert.ok(Math.abs(py - 79.6387) < 0.001);
});
