/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import proj4 from 'proj4';

import { computeCesiumModelOrigin, computeGridConvergence, createCesiumBridge, viewerToEnuRotation } from './cesium-bridge.js';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import PROJ_ORACLE from './__fixtures__/proj-oracle.json' with { type: 'json' };

const KROVAK =
  '+proj=krovak +lat_0=49.5 +lon_0=24.83333333333333 '
  + '+alpha=30.28813972222222 +k=0.9999 +x_0=0 +y_0=0 +ellps=bessel '
  + '+towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56 +units=m +no_defs';

describe('computeGridConvergence (#1408)', () => {
  // EPSG:2065 — S-JTSK (Ferro) / Krovak (East/North). The oblique conic
  // projection used across the Czech Republic has large convergence; the
  // issue file (garage-test-true-north.ifc) sits at ~7.7° off true north.
  it('matches the issue file: ~7.7° convergence near Prague', () => {
    const easting = -737624.9683493343;
    const northing = -1050307.039993465;
    const [, lat] = proj4(KROVAK, 'WGS84', [easting, northing]);
    const gamma = computeGridConvergence(KROVAK, easting, northing, lat);
    const deg = (gamma * 180) / Math.PI;
    // Reporter measured ~7.7°; grid north is WEST of true north here so the
    // grid frame is rotated counter-clockwise (gamma > 0).
    assert.ok(deg > 7 && deg < 8.5, `expected ~7.7°, got ${deg.toFixed(3)}°`);
    assert.ok(gamma > 0, 'Krovak grid north is west of true north (gamma > 0)');
  });

  it('is ~0 on a UTM central meridian and grows toward the zone edge', () => {
    const utm32 = '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs';
    // Central meridian of zone 32N is 9°E → convergence ≈ 0.
    const cm = proj4('WGS84', utm32, [9, 50]);
    const central = computeGridConvergence(utm32, cm[0], cm[1], 50);
    assert.ok(Math.abs(central) < 1e-9, 'central meridian ≈ 0');

    // East of the central meridian, UTM grid north is east of true north
    // (gamma < 0 by our convention) and a couple of degrees in magnitude.
    const edge = proj4('WGS84', utm32, [12, 55]);
    const edgeConv = computeGridConvergence(utm32, edge[0], edge[1], 55);
    assert.ok(edgeConv < 0, 'UTM east of CM: grid north east of true north');
    assert.ok(Math.abs((edgeConv * 180) / Math.PI) > 1, 'edge convergence is degrees-scale');
  });

  it('returns 0 for a geographic (longlat) CRS', () => {
    const longlat = '+proj=longlat +datum=WGS84 +no_defs';
    assert.strictEqual(computeGridConvergence(longlat, 14.5, 50, 50), 0);
  });

  it('names the cause when the probe hop throws instead of returning a bare 0', () => {
    // A convergence of 0 is a legitimate answer (on a UTM central meridian),
    // so the give-up path is otherwise indistinguishable from success: the
    // model would be placed grid-aligned in Cesium's true-north frame with
    // nothing said. Log then, not silence.
    const warnings: unknown[][] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      assert.strictEqual(computeGridConvergence('+proj=not-a-projection', 0, 0, 50), 0);
    } finally {
      console.warn = realWarn;
    }
    assert.strictEqual(warnings.length, 1);
    assert.match(String(warnings[0][0]), /grid convergence unavailable/);
  });
});

describe('viewerToEnuRotation — model/camera share one convergence-corrected rotation (#1408 follow-up)', () => {
  // A Krovak point of the PROJ oracle (scripts/geo/generate-proj-oracle.py).
  const oracle = PROJ_ORACLE.cases.find((c) => c.proj4.includes('+proj=krovak'))!.points[0];
  const gamma = computeGridConvergence(KROVAK, oracle.E, oracle.N, oracle.lat);

  // Bearing (rad, from true north, +east) at which a viewer→ENU rotation places
  // the model's grid-north edge (viewer −Z). ENU = rot · (0,0,−1).
  function gridNorthBearing(rot: ReturnType<typeof viewerToEnuRotation>): number {
    return Math.atan2(-rot.eastFromVz, -rot.northFromVz);
  }
  // PROJ ground truth: geodesic bearing of a grid-north step on the WGS84 globe.
  const truthBearing = -oracle.gammaTrueNorth;

  it('with gamma, grid-north lands on the proj4 footprint bearing (model matches basemap + camera)', () => {
    const rot = viewerToEnuRotation(1, 1, 0, gamma);
    assert.ok(
      Math.abs(gridNorthBearing(rot) - truthBearing) < 1e-9,
      `bearing ${gridNorthBearing(rot)} must equal PROJ truth ${truthBearing}`,
    );
  });

  it('a grid-only rotation (gamma=0, the pre-fix model matrix) is off by the full convergence', () => {
    const rot0 = viewerToEnuRotation(1, 1, 0, 0);
    // Points straight at true north (bearing 0) instead of −gamma...
    assert.ok(Math.abs(gridNorthBearing(rot0)) < 1e-12, 'grid-only points at true north');
    // ...i.e. ~7.7° off the correct basemap bearing for Krovak — the bug.
    const offDeg = Math.abs(gridNorthBearing(rot0) - truthBearing) * 180 / Math.PI;
    assert.ok(offDeg > 7 && offDeg < 8.5, `expected ~7.7° drift, got ${offDeg.toFixed(3)}°`);
  });

  it('carries the Helmert grid rotation + scale (reduces to the legacy sa/so at gamma=0)', () => {
    const hScale = 2, absc = 0.5, ordi = Math.sqrt(3) / 2; // 60° rotated, ×2 scale
    const r = viewerToEnuRotation(hScale, absc, ordi, 0);
    assert.ok(Math.abs(r.eastFromVx - hScale * absc) < 1e-12);
    assert.ok(Math.abs(r.eastFromVz - hScale * ordi) < 1e-12);
    assert.ok(Math.abs(r.northFromVx - hScale * ordi) < 1e-12);
    assert.ok(Math.abs(r.northFromVz - (-hScale * absc)) < 1e-12);
  });

  it('composes R(gamma) after Helmert with a non-trivial rotation AND non-zero gamma (cross terms)', () => {
    const hScale = 1.3, absc = 0.6, ordi = 0.8, gamma = 0.135; // rotated + scaled + convergence
    const r = viewerToEnuRotation(hScale, absc, ordi, gamma);
    // Independent construction: apply the planar rotation R(gamma) to the
    // grid-only (Helmert) coefficients. [e'; n'] = [[cg,-sg],[sg,cg]] [e; n].
    const g = viewerToEnuRotation(hScale, absc, ordi, 0);
    const cg = Math.cos(gamma), sg = Math.sin(gamma);
    assert.ok(Math.abs(r.eastFromVx - (cg * g.eastFromVx - sg * g.northFromVx)) < 1e-12);
    assert.ok(Math.abs(r.northFromVx - (sg * g.eastFromVx + cg * g.northFromVx)) < 1e-12);
    assert.ok(Math.abs(r.eastFromVz - (cg * g.eastFromVz - sg * g.northFromVz)) < 1e-12);
    assert.ok(Math.abs(r.northFromVz - (sg * g.eastFromVz + cg * g.northFromVz)) < 1e-12);
  });

  it('carries unequal X/Y factors through a rotated frame (#4615)', () => {
    const r = viewerToEnuRotation(2, 0.6, 0.8, 0, 3);
    assert.deepStrictEqual(r, {
      eastFromVx: 1.2,
      eastFromVz: 2.4000000000000004,
      northFromVx: 1.6,
      northFromVz: -1.7999999999999998,
    });
  });
});

describe('createCesiumBridge with map-absolute geometry (#2526)', () => {
  // Same fixture shape as reproject.test.ts's #2526 block: geometry already at
  // the absolute EPSG:25833 coordinates (via wasmRtcOffset), MapConversion
  // repeating the anchor with a 90-degree XAxis rotation.
  const vwCoordinateInfo: CoordinateInfo = {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: {
      min: { x: -29.07, y: -0.2, z: -13.68 },
      max: { x: 5.98, y: 3.76, z: 31.68 },
    },
    shiftedBounds: {
      min: { x: -29.07, y: -0.2, z: -13.68 },
      max: { x: 5.98, y: 3.76, z: 31.68 },
    },
    hasLargeCoordinates: false,
    wasmRtcOffset: { x: 312018.898, y: 5996169.654, z: 14 },
  };
  const vwConversion: MapConversion = {
    id: 73,
    sourceCRS: 41,
    targetCRS: 71,
    eastings: 311988.181,
    northings: 5996148.565,
    orthogonalHeight: 0,
    xAxisAbscissa: 0,
    xAxisOrdinate: 1,
  };
  const vwCrs: ProjectedCRS = {
    id: 71,
    name: 'EPSG:25833 ETRS89 / UTM zone 33N',
    geodeticDatum: 'ETRS89',
    mapUnit: 'METRE',
    mapUnitScale: 1,
  };

  it('neutralises the double-applied rotation and reads viewer points at their absolute map position', async () => {
    const bridge = await createCesiumBridge(vwConversion, vwCrs, vwCoordinateInfo, 0.001);
    assert.ok(bridge, 'expected a bridge');
    // The 90-degree XAxis rotation is already baked into the absolute
    // geometry — re-applying it would spin the model around a correct origin.
    assert.strictEqual(bridge.rotationAngle, 0);
    // Viewer origin (0,0,0) = the rtc offset = IFC (312018.898, 5996169.654, 14).
    const geo = bridge.viewerToGeodetic(0, 0, 0);
    assert.ok(geo, 'expected a geodetic position');
    assert.ok(Math.abs(geo.latitude - 54.0794) < 5e-3, `lat ${geo.latitude} should be Rostock`);
    assert.ok(Math.abs(geo.longitude - 12.1264) < 5e-3, `lon ${geo.longitude} should be Rostock`);
    assert.ok(Math.abs(geo.height - 14) < 1e-6, `height ${geo.height} should keep the absolute 14 m`);
  });

  it('draws the absolute (grid) geometry at ground length, 1/k_c', async () => {
    const origin = await computeCesiumModelOrigin(vwConversion, vwCrs, vwCoordinateInfo, 0.001);
    assert.ok(origin);
    assert.equal(origin.gridSource, 'mapAbsolute');
    // UTM 33N 3° east of its central meridian: k = 1.0000336 (PROJ), so the
    // grid-sized model is drawn 34 ppm smaller, less the height reduction.
    assert.ok(origin.groundScale < 1 && origin.groundScale > 1 - 4e-5, `groundScale ${origin.groundScale}`);
  });

  it('applies that ground scale in the real bridge, not only in computeCesiumModelOrigin (#8174 review)', async () => {
    // createCesiumBridge neutralises the conversion for its rotation; the
    // origin must still see the authored anchor, or map-absolute geometry is
    // drawn at grid size again.
    const origin = await computeCesiumModelOrigin(vwConversion, vwCrs, vwCoordinateInfo, 0.001);
    const bridge = await createCesiumBridge(vwConversion, vwCrs, vwCoordinateInfo, 0.001);
    assert.ok(origin && bridge);
    assert.ok(origin.groundScale < 1);
    assert.deepEqual(bridge.viewerRotation, viewerToEnuRotation(
      origin.scaleX * origin.groundScale, 1, 0, origin.gamma, origin.scaleY * origin.groundScale,
    ));
  });
});
