/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The camera pose the measurement reprojection pass last ran for. The
 * animation loop, wheel zoom and a Point-mode hover (#8828) all compare
 * against it, so they agree on when the camera counts as moved.
 */

import type { Camera } from '@ifc-lite/renderer';

export interface MeasureCameraState {
  position: { x: number; y: number; z: number };
  rotation: { azimuth: number; elevation: number };
  distance: number;
  canvasWidth: number;
  canvasHeight: number;
}

type CameraPose = Pick<Camera, 'getPosition' | 'getRotation' | 'getDistance'>;

export function measureCameraState(camera: CameraPose, canvas: { width: number; height: number }): MeasureCameraState {
  return {
    position: camera.getPosition(),
    rotation: camera.getRotation(),
    distance: camera.getDistance(),
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  };
}

export function sameMeasureCameraState(a: MeasureCameraState | null, b: MeasureCameraState): boolean {
  return a !== null &&
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.position.z === b.position.z &&
    a.rotation.azimuth === b.rotation.azimuth &&
    a.rotation.elevation === b.rotation.elevation &&
    a.distance === b.distance &&
    a.canvasWidth === b.canvasWidth &&
    a.canvasHeight === b.canvasHeight;
}
