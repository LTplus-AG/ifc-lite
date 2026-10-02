/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6700: every consumer of the map-conversion axis, against one hand-derived
 * value, over axis x Scale x length unit x IfcMapConversionScaled factors.
 *
 * The expected point is the IfcMapConversion contract formula evaluated in the
 * test body with the axis normalised here:
 *   E = E0 + a*sx*x - b*sy*y,  N = N0 + b*sx*x + a*sy*y
 * (sx, sy) are the effective per-axis scales from `getEffectiveAxisScales`, the
 * existing single home of the Scale / factor / unit rule, which this change does
 * not touch. The grid shape follows an independent reviewer's probe of the PR.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import proj4 from 'proj4';
import { localViewerToProjected } from '@ifc-lite/geometry';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';

import { computeCesiumModelOrigin, createCesiumBridge } from './cesium-bridge.js';
import { projectedDeltaToViewerDelta, viewerDeltaToProjectedDelta } from './cesium-placement.js';
import { getEffectiveAxisScales } from './geo-scale.js';
import { spatialReferenceFromIfc } from './ifc-spatial-reference.js';
import { computeFootprintGeoJSON, reprojectToLatLon, resolveProjection } from './reproject.js';

const CRS: ProjectedCRS = { id: 1, name: 'EPSG:32632', mapUnit: 'METRE', mapUnitScale: 1 };
const AXES: ReadonlyArray<readonly [number, number]> = [[1, 0], [2, 0], [0.5, 0], [3, 4], [0.6, 0.8], [-2, 0], [0, 5]];
const SCALES = [1, 0.9996, 1000];
const LENGTH_UNITS = [1, 0.001];
const FACTORS: ReadonlyArray<readonly [number | undefined, number | undefined]> = [[undefined, undefined], [0.9, 1.1], [1, 1]];
const X = 100;
const Y = 200;
const HALF = 5;
/** Metres. Worst measured agreement was 1.4e-9 m; proj4's own round trip is ~1e-6 m. */
const TOL = 1e-3;

function box(): CoordinateInfo {
  const min = { x: X - HALF, y: -HALF, z: -Y - HALF };
  const max = { x: X + HALF, y: HALF, z: -Y + HALF };
  return { originShift: { x: 0, y: 0, z: 0 }, originalBounds: { min, max }, shiftedBounds: { min, max }, hasLargeCoordinates: false };
}

describe('#6700 agreement grid: six consumers vs the contract formula', () => {
  it('pin, footprint centroid, forward delta, Cesium origin, viewerToGeodetic and the spatial-reference boundary all agree', async () => {
    const def = await resolveProjection(CRS);
    assert.ok(def, 'EPSG:32632 must resolve');
    const toEN = (lon: number, lat: number): [number, number] => proj4('WGS84', def, [lon, lat]) as [number, number];
    const failures: string[] = [];
    let cells = 0;
    for (const axis of AXES) for (const scale of SCALES) for (const lus of LENGTH_UNITS) for (const [fx, fy] of FACTORS) {
      // Scale 1000 in a millimetre project is an effective 1e6 coefficient: it throws the
      // point ~1e8 m out, outside any projection's domain, so proj4 refuses it. Skipped.
      if (scale === 1000 && lus === 0.001) continue;
      const conv: MapConversion = {
        id: 2, sourceCRS: 1, targetCRS: 1, eastings: 500_000, northings: 4_000_000, orthogonalHeight: 0,
        xAxisAbscissa: axis[0], xAxisOrdinate: axis[1], scale, factorX: fx, factorY: fy, factorZ: fx,
      };
      const label = `axis ${axis} scale ${scale} lengthUnit ${lus} factors ${fx},${fy}`;
      const length = Math.hypot(axis[0], axis[1]);
      const a = axis[0] / length;
      const b = axis[1] / length;
      const { x: sx, y: sy } = getEffectiveAxisScales(conv, 1, lus);
      const hand = { e: 500_000 + a * sx * X - b * sy * Y, n: 4_000_000 + b * sx * X + a * sy * Y };
      const info = box();

      const got: Record<string, [number, number] | null> = {};
      const pin = await reprojectToLatLon(conv, CRS, info, lus);
      got.pin = pin && toEN(pin.lon, pin.lat);
      const ring = await computeFootprintGeoJSON(conv, CRS, info, lus);
      if (ring) {
        const corners = ring.slice(0, 4).map(([lon, lat]) => toEN(lon, lat));
        got.footprintCentroid = [corners.reduce((s, c) => s + c[0], 0) / 4, corners.reduce((s, c) => s + c[1], 0) / 4];
      } else got.footprintCentroid = null;
      const delta = viewerDeltaToProjectedDelta(X, -Y, conv, CRS, lus);
      got.forwardDelta = [500_000 + delta.eastings, 4_000_000 + delta.northings];
      const origin = await computeCesiumModelOrigin(conv, CRS, info, lus);
      got.origin = origin && [origin.easting, origin.northing];
      const bridge = await createCesiumBridge(conv, CRS, info, lus);
      const geodetic = bridge?.viewerToGeodetic(X, 0, -Y);
      got.viewerToGeodetic = geodetic ? toEN(geodetic.longitude, geodetic.latitude) : null;
      const ref = spatialReferenceFromIfc({ mapConversion: conv, projectedCRS: CRS, lengthUnitScale: lus });
      const projected = localViewerToProjected(ref, [X, 0, -Y]);
      got.spatialReference = projected && [projected[0], projected[1]];

      for (const [consumer, value] of Object.entries(got)) {
        cells++;
        if (!value) { failures.push(`${label}: ${consumer} returned null`); continue; }
        const error = Math.hypot(value[0] - hand.e, value[1] - hand.n);
        if (!(error < TOL)) failures.push(`${label}: ${consumer} is ${error} m from the contract value`);
      }

      // Inverse: the contract inverse of the hand-derived delta is the viewer delta we started from.
      const inverse = projectedDeltaToViewerDelta(hand.e - 500_000, hand.n - 4_000_000, conv, CRS, lus);
      cells++;
      if (!(Math.hypot(inverse.x - X, inverse.z + Y) < 1e-6)) failures.push(`${label}: inverse placement is off the contract inverse`);
      if (bridge) {
        const r = bridge.viewerRotation;
        cells++;
        const colX = Math.hypot(r.eastFromVx, r.northFromVx);
        const colZ = Math.hypot(r.eastFromVz, r.northFromVz);
        const dot = r.eastFromVx * r.eastFromVz + r.northFromVx * r.northFromVz;
        if (Math.abs(colX - sx) > 1e-9 || Math.abs(colZ - sy) > 1e-9 || Math.abs(dot) > 1e-9) {
          failures.push(`${label}: rotation columns (${colX}, ${colZ}) expected (${sx}, ${sy}), dot ${dot}`);
        }
      }
    }
    assert.deepEqual(failures.slice(0, 10), [], `${failures.length} of ${cells} cells disagree`);
    assert.equal(cells, AXES.length * (SCALES.length * LENGTH_UNITS.length - 1) * FACTORS.length * 8, 'every cell was evaluated');
  });
});
