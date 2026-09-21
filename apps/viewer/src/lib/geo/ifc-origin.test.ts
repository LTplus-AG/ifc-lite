/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { computeIfcOriginViewerPosition, type IfcOriginFrame } from './ifc-origin.js';
import { spatialReferenceFromIfc } from './ifc-spatial-reference.js';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { projectedToLocalViewer, type CoordinateInfo } from '@ifc-lite/geometry';

function crs(name: string, verticalDatum = 'EPSG:5729'): ProjectedCRS {
  return { id: 1, name, verticalDatum, mapUnit: 'METRE', mapUnitScale: 1 };
}

function conversion(eastings: number, northings: number, orthogonalHeight = 0): MapConversion {
  return {
    id: 100, sourceCRS: 10, targetCRS: 1, eastings, northings, orthogonalHeight,
    xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1,
  };
}

function coordinateInfo(overrides: Partial<CoordinateInfo> = {}): CoordinateInfo {
  return {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    hasLargeCoordinates: false,
    ...overrides,
  };
}

function frame(
  mapConversion: MapConversion,
  projectedCRS: ProjectedCRS,
  info = coordinateInfo(),
): IfcOriginFrame {
  return {
    coordinateInfo: info,
    spatialReference: spatialReferenceFromIfc({ mapConversion, projectedCRS, lengthUnitScale: 1, coordinateInfo: info }),
  };
}

describe('computeIfcOriginViewerPosition (#5048)', () => {
  it('shows a non-georeferenced standalone model in its own viewer frame', async () => {
    const info = coordinateInfo({
      originShift: { x: 50, y: 3, z: -20 },
      wasmRtcOffset: { x: 10, y: 7, z: -4 },
    });
    const out = await computeIfcOriginViewerPosition({ coordinateInfo: info }, null);
    assert.deepStrictEqual(out, { viewer: { x: -60, y: 1, z: 27 }, source: 'self' });
  });

  it('keeps the selected anchor in its own frame even when it has a spatial reference', async () => {
    const anchor = frame(conversion(155000, 463000), crs('EPSG:28992'), coordinateInfo({
      originShift: { x: 1, y: 2, z: 3 },
    }));
    assert.deepStrictEqual(
      await computeIfcOriginViewerPosition(anchor, anchor),
      { viewer: { x: -1, y: -2, z: -3 }, source: 'self' },
    );
  });

  it('keeps a model in its recorded pre-alignment frame when its anchor lacks a spatial reference', async () => {
    const model = frame(conversion(1, 2), crs('EPSG:28992'), coordinateInfo({ originShift: { x: 99, y: 1, z: 2 } }));
    const out = await computeIfcOriginViewerPosition({
      ...model,
      preAlignmentCoordinateInfo: model.coordinateInfo,
    }, { coordinateInfo: coordinateInfo() });
    assert.deepStrictEqual(out, { viewer: { x: -99, y: -1, z: -2 }, source: 'fallback' });
  });

  it('uses the neutral inverse for same-CRS origin position, including axis scales and height', async () => {
    const anchor = frame({
      ...conversion(100, 200, 10), factorX: 2, factorY: 4, factorZ: 5,
    }, crs('EPSG:28992'));
    const other = frame(conversion(120, 240, 25), crs('EPSG:28992'));
    const out = await computeIfcOriginViewerPosition(other, anchor);
    assert.deepStrictEqual(out, { viewer: { x: 10, y: 3, z: -10 }, source: 'anchor' });
  });

  it('normalizes the anchor axis and applies its non-unit scale through the shared primitive', async () => {
    const anchor = frame({
      ...conversion(124000, 477000), xAxisAbscissa: 0.6, xAxisOrdinate: 0.8, scale: 2,
    }, crs('EPSG:28992'));
    const other = frame(conversion(124100, 477050), crs('EPSG:28992'));
    const out = await computeIfcOriginViewerPosition(other, anchor);
    assert.ok(out);
    assert.ok(Math.abs(out.viewer.x - 50) < 1e-9);
    assert.ok(Math.abs(out.viewer.y) < 1e-9);
    assert.ok(Math.abs(out.viewer.z - 25) < 1e-9);
  });

  it('reprojects a canonical cross-CRS origin through the neutral map conversions', async () => {
    const proj4 = (await import('proj4')).default;
    // Keep this invariant offline: national-grid transforms can require a
    // browser-fetched precision grid, which is intentionally refused when it
    // is unavailable. These UTM definitions are bundled and deterministic.
    const sourceDef = '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs';
    const targetDef = '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
    const sourceProjected: [number, number, number] = [500000, 5700000, 0];
    const [targetE, targetN] = proj4(sourceDef, targetDef, sourceProjected);
    const anchor = frame(conversion(targetE, targetN), crs('EPSG:25832'));
    const other = frame(conversion(500000, 5700000), crs('EPSG:32631'));
    assert.ok(anchor.spatialReference);
    const raw = projectedToLocalViewer(anchor.spatialReference, sourceProjected);
    assert.ok(raw);
    assert.ok(Math.hypot(raw[0], raw[2]) > 100_000,
      `skipping the zone reprojection must remain visibly wrong: ${raw}`);
    const out = await computeIfcOriginViewerPosition(other, anchor);
    assert.ok(out);
    assert.strictEqual(out.source, 'anchor');
    assert.ok(Math.abs(out.viewer.x) < 1e-6, `x residual = ${out.viewer.x}`);
    assert.ok(Math.abs(out.viewer.z) < 1e-6, `z residual = ${out.viewer.z}`);
  });

  it('normalizes proj4 US-survey-foot coordinates for a cross-CRS origin marker (#5048)', async () => {
    // EPSG:2236's central-meridian false origin is exactly (200000 ft, 0 ft).
    // Its known EPSG:32632 projection is fixed here in metres; passing the
    // metre values straight to proj4 as feet leaves the marker millions of
    // metres from the anchor.
    const feetPerMetre = 1200 / 3937;
    const source = frame(
      conversion(200_000, 0),
      { ...crs('EPSG:2236'), mapUnit: 'US survey foot', mapUnitScale: feetPerMetre },
    );
    const anchor = frame(
      conversion(-9_240_280.602725117, 10_330_575.179250661),
      crs('EPSG:32632'),
    );
    const out = await computeIfcOriginViewerPosition(source, anchor);
    assert.ok(out);
    assert.strictEqual(out.source, 'anchor');
    assert.ok(Math.abs(out.viewer.x) < 1e-5, `easting residual = ${out.viewer.x}`);
    assert.ok(Math.abs(out.viewer.z) < 1e-5, `northing residual = ${out.viewer.z}`);
  });

  it('shares map-absolute neutralization with federation alignment', async () => {
    const anchorInfo = coordinateInfo({
      wasmRtcOffset: { x: 312_018.898, y: 5_996_169.654, z: 14 }, hasLargeCoordinates: true,
    });
    const anchor = frame({
      ...conversion(311_988.181, 5_996_148.565), xAxisAbscissa: 0, xAxisOrdinate: 1,
    }, crs('EPSG:25833'), anchorInfo);
    const other = frame(conversion(312_050, 5_996_100), crs('EPSG:25833'));
    const out = await computeIfcOriginViewerPosition(other, anchor);
    assert.ok(out);
    assert.ok(Math.abs(out.viewer.x - 31.102) < 1e-2);
    assert.ok(Math.abs(out.viewer.z - 69.654) < 1e-2);
  });

  it('refuses an unknown or mismatched vertical frame instead of carrying heights through', async () => {
    const anchor = frame(conversion(0, 0, 100), crs('EPSG:28992', 'EPSG:5729'));
    const unknownVertical = frame(conversion(0, 0, 150), crs('EPSG:28992', ''));
    const mismatchedVertical = frame(conversion(0, 0, 150), crs('EPSG:28992', 'EPSG:5703'));
    assert.strictEqual(await computeIfcOriginViewerPosition(unknownVertical, anchor), null);
    assert.strictEqual(await computeIfcOriginViewerPosition(mismatchedVertical, anchor), null);
  });

  it('refuses an arbitrary CRS display name rather than treating matching labels as identity', async () => {
    const anchor = frame(conversion(0, 0), crs('EPSG:28992'));
    const displayNamed = frame(conversion(10, 20), crs('Dutch survey grid'));
    assert.strictEqual(await computeIfcOriginViewerPosition(displayNamed, anchor), null);
  });
});
