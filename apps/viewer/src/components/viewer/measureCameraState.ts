/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutableRefObject } from 'react';
import { projectToCssScreen } from '../../utils/projectScreen.js';

/**
 * The camera state the measurement reprojection pass last ran for. The
 * animation loop, wheel zoom and a Point-mode hover (#8828) all compare
 * against it, so they agree on when the view counts as changed.
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
  /** The drawing buffer, which the camera's aspect follows. */
  canvasWidth: number;
  canvasHeight: number;
}

interface CameraPose {
  projectToScreen(p: { x: number; y: number; z: number }, w: number, h: number): { x: number; y: number } | null;
  getPosition(): { x: number; y: number; z: number };
  getRotation(): { azimuth: number; elevation: number };
  getDistance(): number;
  getProjectionMode(): string;
  getOrthoSize(): number;
  getFOV(): number;
  getUp(): { x: number; y: number; z: number };
}

export function measureCameraState(camera: CameraPose, canvas: { width: number; height: number }): MeasureCameraState {
  return {
    position: camera.getPosition(),
    rotation: camera.getRotation(),
    distance: camera.getDistance(),
    projectionMode: camera.getProjectionMode(),
    orthoSize: camera.getOrthoSize(),
    fov: camera.getFOV(),
    up: camera.getUp(),
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  };
}

/**
 * The camera itself moved, so something else is now under the cursor. A
 * drawing-buffer resize alone is not that: the buffer drops to pixel ratio 1
 * while the view interacts and grows back once it settles, and still needs
 * the markers reprojected (the camera's aspect follows it), but moves nothing
 * under a resting cursor (#8828).
 */
export function sameMeasureCameraPose(a: MeasureCameraState | null, b: MeasureCameraState): boolean {
  return a !== null && sameAspect(a, b) &&
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
    a.up.z === b.up.z;
}

/**
 * A canvas whose box changed shape (a panel opened, the window resized) shows
 * something else under the cursor. The pixel-ratio swap keeps the shape up to
 * a pixel of rounding, so a ratio tolerance tells the two apart.
 */
function sameAspect(a: MeasureCameraState, b: MeasureCameraState): boolean {
  if (!a.canvasHeight || !b.canvasHeight) return a.canvasHeight === b.canvasHeight;
  return Math.abs(a.canvasWidth / a.canvasHeight / (b.canvasWidth / b.canvasHeight) - 1) < ASPECT_TOLERANCE;
}
const ASPECT_TOLERANCE = 0.01;

/** Nothing the reprojection pass depends on changed. */
export function sameMeasureCameraState(a: MeasureCameraState | null, b: MeasureCameraState): boolean {
  return sameMeasureCameraPose(a, b) && a !== null &&
    a.canvasWidth === b.canvasWidth &&
    a.canvasHeight === b.canvasHeight;
}

/**
 * The measurement reprojection pass, run by the animation loop every frame and
 * by wheel zoom and a Point-mode hover on demand: reproject every stored point
 * when the view changed since the last pass, telling the store whether the
 * camera itself moved, which ends Point mode's Live reading (#8828).
 */
export function reprojectMeasurementsForCamera(
  camera: CameraPose,
  canvas: HTMLCanvasElement,
  lastStateRef: MutableRefObject<MeasureCameraState | null>,
  update: (project: (worldPos: { x: number; y: number; z: number }) => { x: number; y: number } | null, viewMoved: boolean) => void,
): void {
  const last = lastStateRef.current;
  const current = measureCameraState(camera, canvas);
  if (sameMeasureCameraState(last, current)) return;
  lastStateRef.current = current;
  // CSS-space coords so the measure line/labels track the geometry under the
  // cursor (raw coords are drawing-buffer device px, not CSS px — #1107, #5383).
  update((worldPos) => projectToCssScreen(camera, canvas, worldPos), !sameMeasureCameraPose(last, current));
}
