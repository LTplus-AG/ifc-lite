/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The camera pose the measurement reprojection pass last ran for. The
 * animation loop, wheel zoom and a Point-mode hover (#8828) all compare
 * against it, so they agree on when the camera counts as moved.
 */

export interface MeasureCameraState {
  position: { x: number; y: number; z: number };
  rotation: { azimuth: number; elevation: number };
  distance: number;
  /** A projection toggle or an orthographic zoom moves nothing above, yet re-frames the view. */
  projectionMode: string;
  orthoSize: number;
  /** A viewpoint restore can change only these. */
  fov: number;
  up: { x: number; y: number; z: number };
  /**
   * The canvas's CSS box, the space `projectToCssScreen` lands in. Not the
   * drawing buffer: that shrinks to pixel ratio 1 while the view is
   * interacting and grows back once it settles, which moves no projected point.
   */
  cssWidth: number;
  cssHeight: number;
}

interface CameraPose {
  getPosition(): { x: number; y: number; z: number };
  getRotation(): { azimuth: number; elevation: number };
  getDistance(): number;
  getProjectionMode(): string;
  getOrthoSize(): number;
  getFOV(): number;
  getUp(): { x: number; y: number; z: number };
}

export function measureCameraState(camera: CameraPose, canvas: { clientWidth: number; clientHeight: number }): MeasureCameraState {
  return {
    position: camera.getPosition(),
    rotation: camera.getRotation(),
    distance: camera.getDistance(),
    projectionMode: camera.getProjectionMode(),
    orthoSize: camera.getOrthoSize(),
    fov: camera.getFOV(),
    up: camera.getUp(),
    cssWidth: canvas.clientWidth,
    cssHeight: canvas.clientHeight,
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
    a.projectionMode === b.projectionMode &&
    a.orthoSize === b.orthoSize &&
    a.fov === b.fov &&
    a.up.x === b.up.x &&
    a.up.y === b.up.y &&
    a.up.z === b.up.z &&
    a.cssWidth === b.cssWidth &&
    a.cssHeight === b.cssHeight;
}
