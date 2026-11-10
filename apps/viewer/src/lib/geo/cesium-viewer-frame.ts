/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NORMAL_COORD_THRESHOLD_M, type CoordinateInfo, type Vec3 } from '@ifc-lite/geometry';
import { totalYupOffset } from './coordinate-frame';
import type { GeodesicPosition } from './cesium-bridge';
import type { ViewerToEnuRotation } from './viewer-enu-rotation';

/**
 * The renderer-frame point the georeference pivots on, after originShift.
 * Camera, model matrix and map anchor all use it
 * (`computeModelCenterInIfcMeters` is this point in IFC world metres).
 *
 * Normally the centre of the bounds. The exception is a box stretched by
 * elements the site placement never re-based: Vectorworks writes some
 * provision-for-void proxies with absolute placements in site-local numbers,
 * so they sit at the file's own origin, 6000 km from a building placed at its
 * UTM site. The box then reaches both the WASM RTC origin (the median element
 * placement, for a model loaded on its own) and the IFC world origin, and its
 * centre falls between them. The pivot is the RTC origin, in the bulk of the
 * model. A long model, or one federated onto another model's anchor, does not
 * reach the world origin and keeps its centre. When most elements are the
 * unplaced ones, the median follows them.
 */
export function viewerFrameCenter(coordinateInfo: CoordinateInfo | undefined) {
  const bounds = coordinateInfo?.shiftedBounds;
  if (!bounds) return { x: 0, y: 0, z: 0 };
  const center = {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  };
  if (!coordinateInfo?.wasmRtcOffset) return center;
  const shift = coordinateInfo.originShift;
  const rtcOrigin = { x: -shift.x, y: -shift.y, z: -shift.z };
  // Where the file's own (0,0,0) sits in the renderer frame (as ifc-origin.ts `ownOrigin`).
  const offset = totalYupOffset(coordinateInfo);
  const worldOrigin = { x: -offset.x, y: -offset.y, z: -offset.z };
  const t = NORMAL_COORD_THRESHOLD_M;
  const reaches = (p: Vec3) => (['x', 'y', 'z'] as const)
    .every((k) => p[k] >= bounds.min[k] - t && p[k] <= bounds.max[k] + t);
  const offCentre = Math.hypot(center.x - rtcOrigin.x, center.y - rtcOrigin.y, center.z - rtcOrigin.z);
  return offCentre > t && reaches(rtcOrigin) && reaches(worldOrigin) ? rtcOrigin : center;
}

/** The one viewer-to-ECEF matrix used by both the camera and the model. */
export function buildViewerToEcefMatrix(
  Cesium: typeof import('cesium'),
  origin: GeodesicPosition,
  rot: ViewerToEnuRotation,
  viewerUpScale: number,
  coordinateInfo: CoordinateInfo | undefined,
) {
  const center = viewerFrameCenter(coordinateInfo);
  const enuToEcef = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(
    origin.longitude, origin.latitude, origin.height,
  ));
  const viewerToEnu = new Cesium.Matrix4(
    rot.eastFromVx, 0, rot.eastFromVz, -(rot.eastFromVx * center.x + rot.eastFromVz * center.z),
    rot.northFromVx, 0, rot.northFromVz, -(rot.northFromVx * center.x + rot.northFromVz * center.z),
    0, viewerUpScale, 0, -viewerUpScale * center.y,
    0, 0, 0, 1,
  );
  return Cesium.Matrix4.multiply(enuToEcef, viewerToEnu, new Cesium.Matrix4());
}

/**
 * The viewer-to-ECEF matrix of an Exact placement, linearised at `at`: the
 * warp's value there plus its Jacobian (`linearizeWarp`). Agrees with the baked
 * model to second order around `at` (the camera target), d²/(2R): 5 mm at 250 m.
 */
export function buildLinearizedViewerToEcefMatrix(
  Cesium: typeof import('cesium'),
  origin: GeodesicPosition,
  lin: { value: number[]; jacobian: number[][] },
  at: { x: number; y: number; z: number },
) {
  const enuToEcef = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(
    origin.longitude, origin.latitude, origin.height,
  ));
  const j = lin.jacobian;
  const t = [0, 1, 2].map((r) => lin.value[r] - (j[r][0] * at.x + j[r][1] * at.y + j[r][2] * at.z));
  const viewerToEnu = new Cesium.Matrix4(
    j[0][0], j[0][1], j[0][2], t[0],
    j[1][0], j[1][1], j[1][2], t[1],
    j[2][0], j[2][1], j[2][2], t[2],
    0, 0, 0, 1,
  );
  return Cesium.Matrix4.multiply(enuToEcef, viewerToEnu, new Cesium.Matrix4());
}
