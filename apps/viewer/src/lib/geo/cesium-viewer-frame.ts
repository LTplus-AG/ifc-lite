/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { GeodesicPosition } from './cesium-bridge';
import type { ViewerToEnuRotation } from './viewer-enu-rotation';

/** Camera and model consume the same renderer coordinates, after originShift. */
export function viewerFrameCenter(coordinateInfo: CoordinateInfo | undefined) {
  const bounds = coordinateInfo?.shiftedBounds;
  return bounds ? {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  } : { x: 0, y: 0, z: 0 };
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
