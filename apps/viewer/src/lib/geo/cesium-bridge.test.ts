/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import proj4 from 'proj4';

import { computeGridConvergence, viewerToEnuRotation } from './cesium-bridge.js';

/**
 * Independent grid-convergence ground truth: reproject a grid-north step to
 * WGS84 and measure its bearing off true north. This mirrors what proj4 does
 * for the 2D footprint, so `computeGridConvergence` must agree with it (the 3D
 * model and the 2D footprint can't disagree on which way is north — #1408).
 */
function groundTruthConvergence(
  projDef: string,
  easting: number,
  northing: number,
): number {
  const [lon, lat] = proj4(projDef, 'WGS84', [easting, northing]);
  const [lon2, lat2] = proj4(projDef, 'WGS84', [easting, northing + 1]);
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const east = (lon2 - lon) * mPerDegLon;
  const north = (lat2 - lat) * mPerDegLat;
  return Math.atan2(-east, north);
}

describe('computeGridConvergence (#1408)', () => {
  // EPSG:2065 — S-JTSK (Ferro) / Krovak (East/North). The oblique conic
  // projection used across the Czech Republic has large convergence; the
  // issue file (garage-test-true-north.ifc) sits at ~7.7° off true north.
  const KROVAK =
    '+proj=krovak +lat_0=49.5 +lon_0=24.83333333333333 '
    + '+alpha=30.28813972222222 +k=0.9999 +x_0=0 +y_0=0 +ellps=bessel '
    + '+towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56 +units=m +no_defs';

  it('matches the issue file: ~7.7° convergence near Prague', () => {
    const easting = -737624.9683493343;
    const northing = -1050307.039993465;
    const [lon, lat] = proj4(KROVAK, 'WGS84', [easting, northing]);
    const gamma = computeGridConvergence(KROVAK, easting, northing, lon, lat);
    const deg = (gamma * 180) / Math.PI;
    // Reporter measured ~7.7°; grid north is WEST of true north here so the
    // grid frame is rotated counter-clockwise (gamma > 0).
    assert.ok(deg > 7 && deg < 8.5, `expected ~7.7°, got ${deg.toFixed(3)}°`);
    assert.ok(gamma > 0, 'Krovak grid north is west of true north (gamma > 0)');
  });

  it('agrees with the proj4 footprint ground truth (Krovak)', () => {
    const easting = -737624.9683493343;
    const northing = -1050307.039993465;
    const [lon, lat] = proj4(KROVAK, 'WGS84', [easting, northing]);
    const gamma = computeGridConvergence(KROVAK, easting, northing, lon, lat);
    const truth = groundTruthConvergence(KROVAK, easting, northing);
    assert.ok(
      Math.abs(gamma - truth) < 1e-9,
      `convergence ${gamma} must equal footprint truth ${truth}`,
    );
  });

  it('is ~0 on a UTM central meridian and grows toward the zone edge', () => {
    const utm32 = '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs';
    // Central meridian of zone 32N is 9°E → convergence ≈ 0.
    const cm = proj4('WGS84', utm32, [9, 50]);
    const [clon, clat] = proj4(utm32, 'WGS84', cm as [number, number]);
    const central = computeGridConvergence(utm32, cm[0], cm[1], clon, clat);
    assert.ok(Math.abs((central * 180) / Math.PI) < 0.05, 'central meridian ≈ 0°');

    // East of the central meridian, UTM grid north is east of true north
    // (gamma < 0 by our convention) and a couple of degrees in magnitude.
    const edge = proj4('WGS84', utm32, [12, 55]);
    const [elon, elat] = proj4(utm32, 'WGS84', edge as [number, number]);
    const edgeConv = computeGridConvergence(utm32, edge[0], edge[1], elon, elat);
    const edgeTruth = groundTruthConvergence(utm32, edge[0], edge[1]);
    assert.ok(Math.abs(edgeConv - edgeTruth) < 1e-9, 'matches UTM ground truth');
    assert.ok(edgeConv < 0, 'UTM east of CM: grid north east of true north');
    assert.ok(Math.abs((edgeConv * 180) / Math.PI) > 1, 'edge convergence is degrees-scale');
  });

  it('returns 0 for a geographic (longlat) CRS', () => {
    const longlat = '+proj=longlat +datum=WGS84 +no_defs';
    assert.strictEqual(computeGridConvergence(longlat, 14.5, 50, 14.5, 50), 0);
  });
});

describe('viewerToEnuRotation — model/camera share one convergence-corrected rotation (#1408 follow-up)', () => {
  const KROVAK =
    '+proj=krovak +lat_0=49.5 +lon_0=24.83333333333333 '
    + '+alpha=30.28813972222222 +k=0.9999 +x_0=0 +y_0=0 +ellps=bessel '
    + '+towgs84=570.8,85.7,462.8,4.998,1.587,5.261,3.56 +units=m +no_defs';
  const easting = -737624.9683493343;
  const northing = -1050307.039993465;
  const [lon, lat] = proj4(KROVAK, 'WGS84', [easting, northing]);
  const gamma = computeGridConvergence(KROVAK, easting, northing, lon, lat);

  // Bearing (rad, from true north, +east) at which a viewer→ENU rotation places
  // the model's grid-north edge (viewer −Z). ENU = rot · (0,0,−1).
  function gridNorthBearing(rot: ReturnType<typeof viewerToEnuRotation>): number {
    return Math.atan2(-rot.eastFromVz, -rot.northFromVz);
  }
  // proj4 ground truth: bearing of a grid-north step on the true-north globe.
  const truthBearing = -groundTruthConvergence(KROVAK, easting, northing);

  it('with gamma, grid-north lands on the proj4 footprint bearing (model matches basemap + camera)', () => {
    const rot = viewerToEnuRotation(1, 1, 0, gamma);
    assert.ok(
      Math.abs(gridNorthBearing(rot) - truthBearing) < 1e-9,
      `bearing ${gridNorthBearing(rot)} must equal proj4 truth ${truthBearing}`,
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
});
