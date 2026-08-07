/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { computeIfcOriginViewerPosition, type ModelGeorefInput } from './ifc-origin.js';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo } from '@ifc-lite/geometry';

function rdCrs(): ProjectedCRS {
  return { id: 1, name: 'EPSG:28992', mapUnit: 'METRE', mapUnitScale: 1 };
}

function utm31Crs(): ProjectedCRS {
  return { id: 2, name: 'EPSG:25831', mapUnit: 'METRE', mapUnitScale: 1 };
}

function makeConversion(eastings: number, northings: number, height = 0): MapConversion {
  return {
    id: 100,
    sourceCRS: 10,
    targetCRS: 1,
    eastings,
    northings,
    orthogonalHeight: height,
    xAxisAbscissa: 1,
    xAxisOrdinate: 0,
    scale: 1,
  };
}

function emptyCoordinateInfo(): CoordinateInfo {
  return {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
    hasLargeCoordinates: false,
  };
}

describe('computeIfcOriginViewerPosition', () => {
  it('returns -shift - rtcYup for a standalone model (no anchor)', async () => {
    const model: ModelGeorefInput = {
      coordinateInfo: {
        ...emptyCoordinateInfo(),
        originShift: { x: 50, y: 3, z: -20 },
        // shiftedBounds = originalBounds - originShift (createCoordinateInfo's
        // invariant); computeIfcOriginViewerPosition never reads either
        // bounds field, but a fixture no producer could emit is still worth
        // avoiding.
        shiftedBounds: { min: { x: -50, y: -3, z: 20 }, max: { x: -50, y: -3, z: 20 } },
        wasmRtcOffset: { x: 10, y: 7, z: -4 },
      },
    };
    const out = await computeIfcOriginViewerPosition(model, null);
    assert.ok(out);
    assert.strictEqual(out!.source, 'self');
    // rtcYup = (10, -4, -7); total offset (60, -1, -27); negated = (-60, 1, 27)
    assert.strictEqual(out!.viewer.x, -60);
    assert.strictEqual(out!.viewer.y, 1);
    assert.strictEqual(out!.viewer.z, 27);
  });

  it('treats the anchor model as its own frame even with georef present', async () => {
    const conversion = makeConversion(155000, 463000);
    const model: ModelGeorefInput = {
      coordinateInfo: {
        ...emptyCoordinateInfo(),
        originShift: { x: 1, y: 2, z: 3 },
        // shiftedBounds = originalBounds - originShift; unused by this path
        // but kept consistent with the producer's invariant.
        shiftedBounds: { min: { x: -1, y: -2, z: -3 }, max: { x: -1, y: -2, z: -3 } },
      },
      mapConversion: conversion,
      projectedCRS: rdCrs(),
      lengthUnitScale: 1,
    };
    const out = await computeIfcOriginViewerPosition(model, model);
    assert.ok(out);
    assert.strictEqual(out!.source, 'self');
    assert.strictEqual(out!.viewer.x, -1);
    assert.strictEqual(out!.viewer.y, -2);
    assert.strictEqual(out!.viewer.z, -3);
  });

  it('places a same-CRS non-anchor model relative to the anchor by easting/northing diff', async () => {
    // Anchor IFC origin sits at (eastings=124000, northings=477000, h=0) in RD.
    // A second model with eastings=124100, northings=477050 should land in
    // the anchor's viewer-Y-up space at (Δeasting, Δheight, -Δnorthing) =
    // (100, 0, -50) after accounting for the IFC Z-up → viewer Y-up swap,
    // minus the anchor's shift.
    const anchorConv = makeConversion(124000, 477000);
    const anchor: ModelGeorefInput = {
      coordinateInfo: emptyCoordinateInfo(),
      mapConversion: anchorConv,
      projectedCRS: rdCrs(),
      lengthUnitScale: 1,
    };
    const otherConv = makeConversion(124100, 477050);
    const other: ModelGeorefInput = {
      coordinateInfo: emptyCoordinateInfo(),
      mapConversion: otherConv,
      projectedCRS: rdCrs(),
      lengthUnitScale: 1,
    };
    const out = await computeIfcOriginViewerPosition(other, anchor);
    assert.ok(out);
    assert.strictEqual(out!.source, 'anchor');
    // ifcX = +100, ifcY = +50 (Δnorthing positive); viewer Z = -ifcY = -50
    assert.ok(Math.abs(out!.viewer.x - 100) < 1e-9, `viewer.x = ${out!.viewer.x}`);
    assert.ok(Math.abs(out!.viewer.y - 0) < 1e-9, `viewer.y = ${out!.viewer.y}`);
    assert.ok(Math.abs(out!.viewer.z - -50) < 1e-9, `viewer.z = ${out!.viewer.z}`);
  });

  it('inverts a non-identity anchor rotation+scale correctly (mutation-testing round 6)', async () => {
    // Every other same-CRS test in this file uses makeConversion's fixed
    // xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1 for BOTH models — an
    // identity rotation with no scaling. Mutation testing found that lets a
    // sign flip on either rotation cross-term, a dropped ordinate term in
    // anchorDenom, or the anchor's effective-scale computation being
    // hardcoded to 1 all survive undetected, because the (1, 0)/scale=1
    // fixture makes each of those terms either zero or a no-op. This test
    // gives the ANCHOR a genuine rotation (36.87 deg: abscissa 0.6,
    // ordinate 0.8) and a non-unit scale, and pins the exact expected
    // viewer position via an independent hand-derivation (see comments).
    const anchorConv: MapConversion = {
      id: 100, sourceCRS: 10, targetCRS: 1,
      eastings: 124000, northings: 477000, orthogonalHeight: 0,
      xAxisAbscissa: 0.6, xAxisOrdinate: 0.8, scale: 2,
    };
    assert.notStrictEqual(anchorConv.xAxisOrdinate, 0, 'fixture must use a non-zero rotation ordinate');
    assert.notStrictEqual(anchorConv.scale, 1, 'fixture must use a non-unit scale');
    const anchor: ModelGeorefInput = {
      coordinateInfo: emptyCoordinateInfo(),
      mapConversion: anchorConv,
      projectedCRS: rdCrs(),
      lengthUnitScale: 1,
    };
    const otherConv = makeConversion(124100, 477050);
    const other: ModelGeorefInput = {
      coordinateInfo: emptyCoordinateInfo(),
      mapConversion: otherConv,
      projectedCRS: rdCrs(),
      lengthUnitScale: 1,
    };
    const out = await computeIfcOriginViewerPosition(other, anchor);
    assert.ok(out);
    assert.strictEqual(out!.source, 'anchor');
    // dE = 100, dN = 50. anchorScale = 2 (Scale=2, mapUnitScale=lengthUnitScale=1,
    // so the IFC-schema unit-bridge heuristic doesn't override it).
    // anchorDenom = anchorScale * (absc^2 + ord^2) = 2 * (0.36 + 0.64) = 2.
    // invDenom = 0.5.
    // ifcX = invDenom * (absc*dE + ord*dN) = 0.5 * (0.6*100 + 0.8*50) = 50.
    // ifcY = invDenom * (-ord*dE + absc*dN) = 0.5 * (-0.8*100 + 0.6*50) = -25.
    // viewer = { x: ifcX, y: ifcZ(=0), z: -ifcY } (anchor's own shift/RTC are 0).
    assert.ok(Math.abs(out!.viewer.x - 50) < 1e-9, `viewer.x = ${out!.viewer.x}`);
    assert.ok(Math.abs(out!.viewer.y - 0) < 1e-9, `viewer.y = ${out!.viewer.y}`);
    assert.ok(Math.abs(out!.viewer.z - 25) < 1e-9, `viewer.z = ${out!.viewer.z}`);
  });

  it('accounts for orthogonalHeight differences (vertical offset)', async () => {
    const anchor: ModelGeorefInput = {
      coordinateInfo: emptyCoordinateInfo(),
      mapConversion: makeConversion(0, 0, 100),
      projectedCRS: rdCrs(),
      lengthUnitScale: 1,
    };
    const other: ModelGeorefInput = {
      coordinateInfo: emptyCoordinateInfo(),
      mapConversion: makeConversion(0, 0, 150),
      projectedCRS: rdCrs(),
      lengthUnitScale: 1,
    };
    const out = await computeIfcOriginViewerPosition(other, anchor);
    assert.ok(out);
    // Δheight = +50, viewer Y is vertical → y = 50.
    assert.ok(Math.abs(out!.viewer.y - 50) < 1e-9, `viewer.y = ${out!.viewer.y}`);
    assert.ok(Math.abs(out!.viewer.x) < 1e-9);
    assert.ok(Math.abs(out!.viewer.z) < 1e-9);
  });

  it('reprojects across CRSs (RD New ↔ UTM zone 31N) within a few metres', async () => {
    // Anchor in RD at (155000, 463000) — Amersfoort tower origin.
    // Same physical location, expressed in UTM 31N, is roughly (660000, 5780000).
    // Use proj4 to get the exact expected UTM coords, then verify the function
    // brings the second model's origin to the anchor's IFC (0,0,0) (i.e. viewer 0,0,0)
    // within a small tolerance.
    const proj4 = (await import('proj4')).default;
    const rdDef = '+proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.4171,50.3319,465.5524,1.9342,-1.6677,9.1019,4.0725 +units=m +no_defs';
    const utmDef = '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs';
    const [utmE, utmN] = proj4(rdDef, utmDef, [155000, 463000]);

    const anchor: ModelGeorefInput = {
      coordinateInfo: emptyCoordinateInfo(),
      mapConversion: makeConversion(155000, 463000),
      projectedCRS: rdCrs(),
      lengthUnitScale: 1,
    };
    const other: ModelGeorefInput = {
      coordinateInfo: emptyCoordinateInfo(),
      mapConversion: makeConversion(utmE, utmN),
      projectedCRS: utm31Crs(),
      lengthUnitScale: 1,
    };
    const out = await computeIfcOriginViewerPosition(other, anchor);
    assert.ok(out);
    assert.strictEqual(out!.source, 'anchor');
    // Round-trip should land at the anchor origin within a small tolerance.
    // Both directions go through +towgs84 approximations, so a few metres of
    // residual is acceptable.
    assert.ok(Math.abs(out!.viewer.x) < 5, `viewer.x residual = ${out!.viewer.x}`);
    assert.ok(Math.abs(out!.viewer.z) < 5, `viewer.z residual = ${out!.viewer.z}`);
  });

  it('falls back to the model own frame when the anchor lacks georef', async () => {
    const model: ModelGeorefInput = {
      coordinateInfo: {
        ...emptyCoordinateInfo(),
        originShift: { x: 99, y: 1, z: 2 },
        // shiftedBounds = originalBounds - originShift; unused by this path
        // but kept consistent with the producer's invariant.
        shiftedBounds: { min: { x: -99, y: -1, z: -2 }, max: { x: -99, y: -1, z: -2 } },
      },
      mapConversion: makeConversion(1, 2),
      projectedCRS: rdCrs(),
      lengthUnitScale: 1,
    };
    const anchorWithoutGeoref: ModelGeorefInput = {
      coordinateInfo: emptyCoordinateInfo(),
      // No mapConversion / projectedCRS — represents a model loaded without georef.
    };
    const out = await computeIfcOriginViewerPosition(model, anchorWithoutGeoref);
    assert.ok(out);
    assert.strictEqual(out!.source, 'fallback');
    assert.strictEqual(out!.viewer.x, -99);
  });
});
