/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import proj4 from 'proj4';

import { computeGridConvergence } from './cesium-bridge.js';

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
