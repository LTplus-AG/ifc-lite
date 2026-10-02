/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The #6700 stated invariant, through the real projection and placement APIs.
 * Metre model, metre CRS (EPSG:32632), offsets (0,0,0), Scale 1, no factors,
 * engineering point (500000, 4000000): axis (1,0), (2,0) and (0.5,0) must
 * project the same point.
 *
 * Run from apps/viewer:
 *   npx tsx --import ./src/test/vite-module-hooks.mjs \
 *     ../../docs/architecture/evidence/6700-map-axis-direction/invariant.mts
 */

import { reprojectToLatLon } from '../../../../apps/viewer/src/lib/geo/reproject.ts';
import { computeCesiumModelOrigin } from '../../../../apps/viewer/src/lib/geo/cesium-bridge.ts';
import { viewerDeltaToProjectedDelta } from '../../../../apps/viewer/src/lib/geo/cesium-placement.ts';
import { spatialReferenceFromIfc } from '../../../../apps/viewer/src/lib/geo/ifc-spatial-reference.ts';
import { localViewerToProjected } from '../../../../packages/geometry/src/spatial-reference.ts';

const crs = { id: 1, name: 'EPSG:32632', mapUnit: 'METRE', mapUnitScale: 1 };
// IFC (500000, 4000000, 0) in metres == viewer (500000, 0, -4000000).
const point = { x: 500_000, y: 0, z: -4_000_000 };
const info = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: point, max: point },
  shiftedBounds: { min: point, max: point },
  hasLargeCoordinates: false,
};

for (const [a, b] of [[1, 0], [2, 0], [0.5, 0]]) {
  const conversion = {
    id: 2, sourceCRS: 1, targetCRS: 1, eastings: 0, northings: 0, orthogonalHeight: 0, scale: 1,
    xAxisAbscissa: a, xAxisOrdinate: b,
  };
  const origin = await computeCesiumModelOrigin(conversion, crs, info, 1);
  const pin = await reprojectToLatLon(conversion, crs, info, 1);
  const delta = viewerDeltaToProjectedDelta(point.x, point.z, conversion, crs, 1);
  const reference = spatialReferenceFromIfc({
    mapConversion: conversion, projectedCRS: crs, lengthUnitScale: 1,
  });
  const boundary = localViewerToProjected(reference, [point.x, 0, point.z]);
  console.log(JSON.stringify({
    axis: [a, b],
    cesiumOrigin_EN: origin && [origin.easting, origin.northing],
    pin_latLon: pin && [pin.lat, pin.lon],
    placementDelta_EN: [delta.eastings, delta.northings],
    spatialReference_EN: boundary && [boundary[0], boundary[1]],
  }));
}
