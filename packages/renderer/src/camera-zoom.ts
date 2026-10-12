/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Zoom pose calculations shared by direct gestures and camera inertia. */
import type { Vec3 } from './types.js';
import type { CameraInternalState } from './camera-state.js';
import { MathUtils } from './math.js';
import { CAMERA_CONSTANTS as CC } from './constants.js';
import { isUsableUp } from './camera-guards.js';
import { MAX_RTE_SOURCE_ABS_METRES } from './relative-to-eye.js';

function normalizedScreenRight(forward: Vec3, up: Vec3): Vec3 {
  const v = MathUtils.cross(forward, up);
  const length = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  const scale = 1 / length;
  return Number.isFinite(length) && length > 1e-10
    ? { x: v.x * scale, y: v.y * scale, z: v.z * scale } : { x: 0, y: 0, z: 0 };
}

interface ZoomPose { position: Vec3; target: Vec3 }

/** Largest absolute coordinate; invalid coordinates cannot be admitted. */
function poseMagnitude(pose: ZoomPose): number {
  const values = [pose.position.x, pose.position.y, pose.position.z, pose.target.x, pose.target.y, pose.target.z];
  return values.every(Number.isFinite) ? Math.max(...values.map(Math.abs)) : Infinity;
}

/** #7493: prevent zoom leaving the envelope, but preserve recovery after another
 * control has moved outside it. Each recovery step must strictly reduce excess. */
export function canAdmitZoomPose(next: ZoomPose, before: ZoomPose): boolean {
  const magnitude = poseMagnitude(next);
  return magnitude <= MAX_RTE_SOURCE_ABS_METRES
    || (Number.isFinite(magnitude) && Number.isFinite(poseMagnitude(before)) && magnitude < poseMagnitude(before));
}

export function captureZoomState(state: CameraInternalState, pivot: Vec3 | null) {
  return { position: { ...state.camera.position }, target: { ...state.camera.target },
    orthoSize: state.orthoSize, pivot: pivot ? { ...pivot } : null };
}

/** Refuse an unsafe notch atomically, including its cursor anchor and pivot.
 * The unchanged frame remains usable and the opposite gesture can recover.
 * Do not clamp axes separately: that would rotate the viewing direction. */
export function acceptZoomStep(state: CameraInternalState, pivot: Vec3 | null, before: ReturnType<typeof captureZoomState>): boolean {
  if (canAdmitZoomPose(state.camera, before)) return true;
  Object.assign(state.camera.position, before.position);
  Object.assign(state.camera.target, before.target);
  state.orthoSize = before.orthoSize;
  if (pivot && before.pivot) Object.assign(pivot, before.pivot);
  return false;
}

/**
 * Orthographic: set view volume size, keep camera distance unchanged.
 *
 * `nextOrthoSize` has already been through {@link usableOrthoSize} — this is
 * one of the two writers that bypass `Camera.setOrthoSize`, and the read-site
 * backstop in `updateMatrices` only keeps the projection *matrix* finite:
 * `getOrthoSize()` reads the state directly and that is what a saved
 * viewpoint persists (#2461).
 */
export function zoomOrthographic(state: CameraInternalState, dir: Vec3, nextOrthoSize: number): void {
  state.orthoSize = nextOrthoSize;
  state.camera.position.x = state.camera.target.x + dir.x;
  state.camera.position.y = state.camera.target.y + dir.y;
  state.camera.position.z = state.camera.target.z + dir.z;
}

/**
 * Perspective: dolly-zoom — combines distance reduction with forward travel.
 *
 * Pure multiplicative zoom suffers from Zeno's paradox: each step covers a
 * smaller absolute distance, so the user asymptotically approaches the target
 * but can never pass it. By splitting each zoom step into distance reduction +
 * forward dolly, the camera always makes real progress through the scene.
 */
export function zoomPerspective(state: CameraInternalState, orbitCenter: Vec3 | null, distance: number, forward: Vec3, zoomFactor: number, fastZoom?: boolean): void {
  const zoomStep = distance * (1 - zoomFactor); // positive when zooming in

  // Fast zoom (Shift+scroll or Cesium mode): pure dolly — the full zoom step
  // translates the rig forward, distance stays constant, no Zeno slow-down.
  // Normal zoom: half dolly + half distance reduction — gives zoom-to-cursor
  // convergence but decelerates as the camera approaches the target.
  const dolly = fastZoom ? zoomStep : zoomStep * 0.5;
  const newDistance = fastZoom ? distance : Math.max(CC.MIN_PERSPECTIVE_DISTANCE, distance - zoomStep * 0.5);

  // Move target (and orbit center) forward to traverse the scene
  const dollyOffset = { x: forward.x * dolly, y: forward.y * dolly, z: forward.z * dolly };
  for (const point of orbitCenter ? [state.camera.target, orbitCenter] : [state.camera.target]) {
    point.x += dollyOffset.x;
    point.y += dollyOffset.y;
    point.z += dollyOffset.z;
  }

  // Position camera at new distance from updated target
  const t = state.camera.target;
  Object.assign(state.camera.position, {
    x: t.x - forward.x * newDistance,
    y: t.y - forward.y * newDistance,
    z: t.z - forward.z * newDistance,
  });
}

/** Shift target toward the world point under the mouse cursor. */
export function shiftTargetTowardsMouse(
  state: CameraInternalState,
  dir: Vec3, distance: number, forward: Vec3, zoomFactor: number,
  mouseX: number, mouseY: number, canvasWidth: number, canvasHeight: number,
): void {
  // The cursor anchor is the one place a gesture reads `up` and writes the
  // result into the pose, and `up` is as externally authored as `position`
  // and `target` are — so the distance guard in `zoom()` is not the whole
  // check. An unusable `up` makes `right` and `actualUp` non-finite, and the
  // three lines at the bottom put that straight into `camera.target`, which
  // `zoomPerspective`/`zoomOrthographic` then copy into `camera.position`:
  // one bad component of `up` becomes all six of the pose in a single wheel
  // notch. The guard belongs here rather than in `zoom()` because `up` feeds
  // only this branch — returning from `zoom()` would also kill the plain
  // zoom, which never touches `up` — and rather than in `setUp`, because the
  // animated viewpoint-restore path writes `camera.up` through
  // `animateToWithUp` without going near the setter.
  //
  // Dropping the anchor is the fallback the surrounding code already uses:
  // it is exactly what a zero-length or view-parallel `up` produces today
  // (`normalize` returns `{0,0,0}`, so `mouseWorld` collapses onto `target`
  // and the target does not move). The zoom itself still happens, centred
  // rather than cursor-anchored, and the pose is left as it was found.
  if (!isUsableUp(state.camera.up)) return;

  const ndcX = (mouseX / canvasWidth) * 2 - 1;
  const ndcY = 1 - (mouseY / canvasHeight) * 2;

  const right = normalizedScreenRight(forward, state.camera.up);
  const actualUp = MathUtils.cross(right, forward);

  const halfHeight = state.projectionMode === 'orthographic'
    ? state.orthoSize
    : distance * Math.tan(state.camera.fov / 2);
  const halfWidth = halfHeight * state.camera.aspect;

  // World point under mouse cursor (on the target plane)
  const t = state.camera.target;
  const mouseWorld = {
    x: t.x + right.x * ndcX * halfWidth + actualUp.x * ndcY * halfHeight,
    y: t.y + right.y * ndcX * halfWidth + actualUp.y * ndcY * halfHeight,
    z: t.z + right.z * ndcX * halfWidth + actualUp.z * ndcY * halfHeight,
  };

  const moveAmount = 1 - zoomFactor;
  t.x += (mouseWorld.x - t.x) * moveAmount;
  t.y += (mouseWorld.y - t.y) * moveAmount;
  t.z += (mouseWorld.z - t.z) * moveAmount;
}

