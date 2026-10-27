/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GeoWarp's exact per-point mapping against PROJ (#8189). Expected
 * positions are `__fixtures__/proj-oracle.json` (`warp*`, written by
 * `scripts/geo/generate-proj-oracle.py`): PROJ's lon, lat, h and ECEF, with
 * the stated geoid plane `warpGeoid` both sides apply.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import PROJ_ORACLE from './__fixtures__/proj-oracle.json' with { type: 'json' };
import { computeCesiumModelOrigin } from './cesium-bridge.js';
import { effectiveMapConversionForGeometry } from './map-absolute.js';
import { resolveProjection } from './reproject.js';
import { enuFrameAt } from './geo-ecef.js';
import { createGeoMapping, type GeoMapping, type GeoMappingInput, type GeoWarpOrigin } from './geo-warp.js';
import {
  dist, geoidPlane, gridViewer, ecefOf, RIGID_OFFSET, rigidLine, type WarpCase,
} from '@/test/geo-warp-fixture.js';

const UTM32: ProjectedCRS = { id: 3, name: 'EPSG:32632', mapUnitScale: 1 };
/** WKT1 of the oracle's DHDN / GK4 case, with its 7-parameter TOWGS84 (no EPSG id: a registered definition). */
const DHDN_GK4_WKT1 = 'PROJCS["DHDN GK4 custom",GEOGCS["DHDN",DATUM["Deutsches_Hauptdreiecksnetz",SPHEROID["Bessel 1841",6377397.155,299.1528128],TOWGS84[598.1,73.7,418.2,0.202,0.045,-2.455,6.7]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",12],PARAMETER["scale_factor",1],PARAMETER["false_easting",4500000],PARAMETER["false_northing",0],UNIT["metre",1]]';
/** An EPSG-identified WKT2 whose declared extent (BBOX) is a 0.2° box round the oracle's first anchor. */
const UTM32_WKT2_BOXED = 'PROJCRS["WGS 84 / UTM zone 32N",BASEGEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563]]],CONVERSION["UTM zone 32N",METHOD["Transverse Mercator"]],CS[Cartesian,2],AXIS["easting",east],AXIS["northing",north],USAGE[SCOPE["test"],BBOX[49.9,8.9,50.1,9.1]],ID["EPSG",32632]]';

/** Every point of `points` through `m`, worst ECEF distance to PROJ (metres). */
function worstVsProj<P extends { ecef: number[] }>(m: GeoMapping, points: P[], viewer: (p: P) => readonly [number, number, number]) {
  const frame = enuFrameAt(m.anchor.latitude, m.anchor.longitude, m.anchor.height);
  let worst = 0;
  for (const p of points) {
    const enu = [0, 0, 0];
    assert.ok(m.toEnu(...viewer(p), enu), `unplaceable ${JSON.stringify(viewer(p))}`);
    worst = Math.max(worst, dist(ecefOf(frame, enu), p.ecef));
  }
  return worst;
}

/** The anchor as PROJ places it: what `computeCesiumModelOrigin` returns for the rigid line. */
function oracleOrigin(c: WarpCase): GeoWarpOrigin {
  return {
    longitude: c.anchor.lon, latitude: c.anchor.lat, height: c.anchor.h, ifcOriginHeight: c.anchor.H,
    easting: c.anchor.E, northing: c.anchor.N, scaleX: 1, scaleY: 1, scaleZ: 1,
    combinedScaleFactor: 1, gridSource: 'rigidOperation',
  };
}

/** `computeCesiumModelOrigin` as the bridge calls it, the anchor clamped to the oracle's ellipsoidal height. */
async function bridgeOrigin(conversion: MapConversion, crs: ProjectedCRS, info: CoordinateInfo, anchorH: number) {
  const origin = await computeCesiumModelOrigin(conversion, crs, info, 1, anchorH, true);
  assert.ok(origin, 'the bridge places the anchor');
  return origin;
}

describe('GeoWarp exact mapping vs PROJ: IfcRigidOperation grid coordinates', () => {
  for (const c of PROJ_ORACLE.warp) {
    it(`${c.case} at ${c.anchor.lon.toFixed(2)}°E: every point of a 20 km line within 1 mm`, () => {
      const line = rigidLine(c);
      const m = createGeoMapping({ ...line, projDef: c.proj4, origin: oracleOrigin(c), geoid: geoidPlane(c.anchor) });
      assert.ok(m);
      const worst = worstVsProj(m, c.points, gridViewer);
      assert.ok(worst < 1e-3, `worst ${(worst * 1000).toFixed(4)} mm`);
    });
  }

  it('the 7-parameter case exercises its shift: without +towgs84 the same line misses PROJ by over 100 m', () => {
    const c = PROJ_ORACLE.warp[2];
    assert.match(c.proj4, /\+towgs84=/);
    const m = createGeoMapping({ ...rigidLine(c), projDef: c.proj4.replace(/\+towgs84=\S+/, ''),
      origin: oracleOrigin(c), geoid: geoidPlane(c.anchor) });
    assert.ok(m);
    assert.ok(worstVsProj(m, c.points.slice(0, 2), gridViewer) > 100);
  });

  it('bends with the Earth: 10 km grid-east of a UTM central-meridian anchor sits r²/2(N+h) below its tangent plane', () => {
    const c = PROJ_ORACLE.warp[0];
    const m = createGeoMapping({ ...rigidLine(c), projDef: c.proj4, origin: oracleOrigin(c), geoid: () => 0 });
    assert.ok(m);
    const out = [0, 0, 0];
    assert.ok(m.toEnu(RIGID_OFFSET.x + 10_000, c.anchor.H, -RIGID_OFFSET.y, out));
    // 10 km of grid on the UTM central meridian (k0 = 0.9996) is 10 004 m of ground;
    // the prime-vertical radius N at 50°N is 6 390 702 m.
    const r = 10_000 / 0.9996;
    const expected = (r * r) / (2 * (6_390_702 + c.anchor.H));
    assert.ok(Math.abs(-out[2] - expected) < 0.01, `drop ${-out[2]} m, closed form ${expected} m`);
  });
});

describe('GeoWarp: which coordinates are map coordinates', () => {
  it('map-absolute geometry (#2526) is read from the AUTHORED conversion and projects as grid coordinates', async () => {
    const c = PROJ_ORACLE.warp[0];
    // The #2526 signature: geometry at absolute E/N (re-based by originShift) and a
    // conversion repeating the anchor with a 90° XAxis rotation and a scale.
    const conversion: MapConversion = { id: 1, sourceCRS: 2, targetCRS: 3, eastings: c.anchor.E, northings: c.anchor.N,
      orthogonalHeight: 0, xAxisAbscissa: 0, xAxisOrdinate: 1, scale: 0.9996 };
    // The absolute offset is split between the wasm RTC re-base (IFC Z-up) and the viewer origin shift.
    const wasmRtcOffset = { x: 400_000, y: 5_000_000, z: 0 };
    const shift = { x: c.anchor.E - wasmRtcOffset.x, y: 0, z: -(c.anchor.N - wasmRtcOffset.y) };
    const half = 7072;
    const shiftedBounds = { min: { x: -half, y: 100, z: -half }, max: { x: half, y: 150, z: half } };
    const coordinateInfo: CoordinateInfo = {
      originShift: shift, wasmRtcOffset, shiftedBounds, hasLargeCoordinates: true,
      originalBounds: { min: { x: -half + shift.x, y: 100, z: -half + shift.z }, max: { x: half + shift.x, y: 150, z: half + shift.z } },
    };
    const origin = await bridgeOrigin(conversion, UTM32, coordinateInfo, c.anchor.h);
    assert.equal(origin.gridSource, 'mapAbsolute');
    const projDef = await resolveProjection(UTM32);
    assert.ok(projDef);
    const input: GeoMappingInput = { mapConversion: conversion, projectedCRS: UTM32, projDef, coordinateInfo,
      origin, geoid: geoidPlane(c.anchor) };
    const m = createGeoMapping(input);
    assert.ok(m);
    const worst = worstVsProj(m, c.points, (p) => [p.dE, p.H, -p.dN]);
    assert.ok(worst < 1e-3, `worst ${(worst * 1000).toFixed(4)} mm`);
    // A neutralised copy has lost the anchor the detection needs: refused, not misread.
    const neutralised = effectiveMapConversionForGeometry(conversion, 1, coordinateInfo);
    assert.equal(neutralised.eastings, 0);
    assert.equal(createGeoMapping({ ...input, mapConversion: neutralised }), null);
  });

  it('plain IfcMapConversion is true length: projects E0 + k_c·R·x, the decision the oracle encodes', async () => {
    const t = PROJ_ORACLE.warpTrueLength;
    const conversion: MapConversion = { id: 1, sourceCRS: 2, targetCRS: 3, eastings: t.origin.E, northings: t.origin.N,
      orthogonalHeight: 0, xAxisAbscissa: t.origin.xAxisAbscissa, xAxisOrdinate: t.origin.xAxisOrdinate };
    const half = 7072;
    const shiftedBounds = {
      min: { x: t.center.x - half, y: 100, z: -t.center.y - half },
      max: { x: t.center.x + half, y: 150, z: -t.center.y + half },
    };
    const coordinateInfo: CoordinateInfo = { originShift: { x: 0, y: 0, z: 0 }, shiftedBounds,
      originalBounds: shiftedBounds, hasLargeCoordinates: false };
    const origin = await bridgeOrigin(conversion, UTM32, coordinateInfo, t.anchor.h);
    assert.equal(origin.gridSource, null);
    // Main's k_c (finite differences through proj4) against PROJ get_factors with R/(R+h).
    assert.ok(Math.abs(origin.combinedScaleFactor - t.combinedScaleFactor) < 1e-9);
    const projDef = await resolveProjection(UTM32);
    assert.ok(projDef);
    const m = createGeoMapping({ mapConversion: conversion, projectedCRS: UTM32, projDef, coordinateInfo, origin,
      geoid: geoidPlane(t.anchor) });
    assert.ok(m);
    const worst = worstVsProj(m, t.points, (p) => [p.x, p.H, -p.y]);
    assert.ok(worst < 1e-3, `worst ${(worst * 1000).toFixed(4)} mm`);
    // So 100 m of model is 100 m on the globe at the anchor (R/(R+h) and k cancel to 2e-7).
    const a = [0, 0, 0], b = [0, 0, 0];
    m.toEnu(t.center.x - 50, t.center.H, -t.center.y, a);
    m.toEnu(t.center.x + 50, t.center.H, -t.center.y, b);
    assert.ok(Math.abs(dist(a, b) - 100) < 1e-4, `100 m drawn as ${dist(a, b)} m`);
  });

  it('a geographic CRS is the topocentric frame: matches PROJ\'s inverse +proj=topocentric', async () => {
    const g = PROJ_ORACLE.warpGeographic;
    const crs: ProjectedCRS = { id: 3, name: 'EPSG:4326', mapUnitScale: 1 };
    const a = Math.cos(Math.PI / 6), b = Math.sin(Math.PI / 6);
    const conversion: MapConversion = { id: 1, sourceCRS: 2, targetCRS: 3, eastings: g.anchor.lon, northings: g.anchor.lat,
      orthogonalHeight: g.anchor.h, xAxisAbscissa: a, xAxisOrdinate: b };
    const center = { x: 300, y: 0, z: -200 };
    const half = 7072;
    const shiftedBounds = {
      min: { x: center.x - half, y: -25, z: center.z - half }, max: { x: center.x + half, y: 25, z: center.z + half },
    };
    const coordinateInfo: CoordinateInfo = { originShift: { x: 0, y: 0, z: 0 }, shiftedBounds,
      originalBounds: shiftedBounds, hasLargeCoordinates: false };
    const origin = await computeCesiumModelOrigin(conversion, crs, coordinateInfo, 1, undefined, true);
    assert.ok(origin);
    const projDef = await resolveProjection(crs);
    assert.ok(projDef);
    const m = createGeoMapping({ mapConversion: conversion, projectedCRS: crs, projDef, coordinateInfo, origin, geoid: () => 0 });
    assert.ok(m);
    // IFC local (x, y) is the ENU offset turned back by the XAxis angle (30°).
    const viewer = (p: { e: number; n: number; u: number }) =>
      [center.x + a * p.e + b * p.n, center.y + p.u, center.z - (-b * p.e + a * p.n)] as const;
    const worst = worstVsProj(m, g.points, viewer);
    assert.ok(worst < 1e-3, `worst ${(worst * 1000).toFixed(4)} mm`);
    for (const p of g.points) {
      const geo = m.toGeodetic(...viewer(p));
      assert.ok(geo);
      assert.ok(Math.abs(geo.latitude - p.lat) < 1e-9 && Math.abs(geo.longitude - p.lon) < 1e-9);
      assert.ok(Math.abs(geo.ellipsoidalHeight - p.h) < 1e-3, `h ${geo.ellipsoidalHeight} vs ${p.h}`);
    }
  });
});

describe('GeoWarp with IfcWellKnownText definitions', () => {
  it('a registered WKT (DHDN, TOWGS84) places the 20 km line where PROJ does', async () => {
    const c = PROJ_ORACLE.warp[2];
    const crs: ProjectedCRS = { id: 3, name: 'WKT', wellKnownText: DHDN_GK4_WKT1, mapUnitScale: 1 };
    const projDef = await resolveProjection(crs);
    assert.ok(projDef, 'the WKT resolves');
    assert.ok(projDef.startsWith('IFC-WKT:'), projDef);
    const line = rigidLine(c);
    const origin = await bridgeOrigin(line.mapConversion, crs, line.coordinateInfo, c.anchor.h);
    const m = createGeoMapping({ ...line, projectedCRS: crs, projDef, origin, geoid: geoidPlane(c.anchor) });
    assert.ok(m);
    const worst = worstVsProj(m, c.points, gridViewer);
    assert.ok(worst < 1e-3, `worst ${(worst * 1000).toFixed(4)} mm`);
  });

  it('an EPSG-identified WKT keeps its declared extent: points beyond it are refused', async () => {
    const c = PROJ_ORACLE.warp[0];
    const crs: ProjectedCRS = { id: 3, name: 'WKT', wellKnownText: UTM32_WKT2_BOXED, mapUnitScale: 1 };
    const projDef = await resolveProjection(crs);
    assert.ok(projDef, 'the WKT resolves');
    assert.ok(projDef.startsWith('IFC-WKT:'), `the extent-carrying alias, got ${projDef}`);
    const line = rigidLine(c);
    const origin = await bridgeOrigin(line.mapConversion, crs, line.coordinateInfo, c.anchor.h);
    const m = createGeoMapping({ ...line, projectedCRS: crs, projDef, origin, geoid: geoidPlane(c.anchor) });
    assert.ok(m);
    const worst = worstVsProj(m, c.points, gridViewer);
    assert.ok(worst < 1e-3, `inside the extent: worst ${(worst * 1000).toFixed(4)} mm`);
    // 120 km grid north is 50.9°N: beyond BBOX north 50.1° plus the 0.5° margin.
    const out = [0, 0, 0];
    assert.equal(m.toEnu(RIGID_OFFSET.x, c.anchor.H, -(RIGID_OFFSET.y + 120_000), out), false);
    assert.equal(m.toGeodetic(RIGID_OFFSET.x, c.anchor.H, -(RIGID_OFFSET.y + 120_000)), null);
  });
});

describe('GeoWarp refusals', () => {
  const c = PROJ_ORACLE.warp[0];
  const base = { ...rigidLine(c), projDef: c.proj4, origin: oracleOrigin(c), geoid: geoidPlane(c.anchor) };

  it('refuses a non-finite point instead of returning NaN', () => {
    const m = createGeoMapping(base);
    assert.ok(m);
    const out = [7, 7, 7];
    assert.equal(m.toEnu(Number.NaN, 0, 0, out), false);
    assert.equal(m.toGeodetic(0, Number.POSITIVE_INFINITY, 0), null);
  });

  it('refuses to build from a non-finite origin, a degenerate XAxis, or a non-positive k_c', () => {
    assert.equal(createGeoMapping({ ...base, origin: { ...base.origin, latitude: Number.NaN } }), null);
    assert.equal(createGeoMapping({ ...base, origin: { ...base.origin, combinedScaleFactor: 0 } }), null);
    assert.equal(createGeoMapping({ ...base, mapConversion: { ...base.mapConversion, xAxisAbscissa: 0, xAxisOrdinate: 0 } }), null);
  });

  it('refuses an origin computed for another reading of the geometry (true-length vs grid)', () => {
    assert.equal(createGeoMapping({ ...base, origin: { ...base.origin, gridSource: null } }), null);
  });
});
