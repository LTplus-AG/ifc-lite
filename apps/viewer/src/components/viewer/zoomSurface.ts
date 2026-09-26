/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The surface a zoom-in approaches (#5393, #5547, #5924), shared by every zoom
 * entry point: the wheel (`wheelZoom.ts`, which trackpad pinch also arrives
 * as), touch pinch (`useTouchControls.ts`), and the cursorless toolbar zoom-in
 * and SpaceMouse dolly ({@link createCentreSurfaceZoom}). Each picks a point
 * here and hands it to `Camera.zoom(..., surfacePoint)`, which stops short of
 * it instead of passing through thin objects.
 */

import { isPivotRaycastTooExpensive, type PivotCensusScene } from './orbitPivotCensus.js';

/** World-space point on the visible surface under the cursor or pinch. */
export interface SurfacePoint { x: number; y: number; z: number }

/** A canvas point (CSS px) to the surface under it, or null for empty space. */
export type ZoomSurfacePicker = (x: number, y: number) => SurfacePoint | null;

/** What {@link createZoomSurfacePicker} needs from the renderer. */
export interface ZoomSurfaceRenderer {
  getScene(): PivotCensusScene;
  raycastScene(x: number, y: number, options: ZoomSurfacePickOptions): { intersection: { point: SurfacePoint } } | null;
}
export interface ZoomSurfacePickOptions { isStreaming: boolean; hiddenIds: Set<number>; isolatedIds: Set<number> | null }

/**
 * The viewer's surface pick, under the same gate the orbit pivot raycast uses
 * (useMouseControls, orbitPivotCensus.ts): the first CPU raycast builds a BVH
 * over every entity, which stalls large models for seconds, and while
 * streaming the mesh set changes under it. So no pick (plain zoom) while
 * streaming, above the census limit, or on a model with a robust orbit anchor
 * (#1394), whose sparse far tail makes the raycast both slow and unneeded.
 */
export function createZoomSurfacePicker(
  renderer: ZoomSurfaceRenderer,
  camera: { getOrbitAnchorBounds(): unknown },
  getPickOptions: () => ZoomSurfacePickOptions,
): ZoomSurfacePicker {
  return (x, y) => {
    const options = getPickOptions();
    if (options.isStreaming || camera.getOrbitAnchorBounds() !== null) return null;
    if (isPivotRaycastTooExpensive(renderer.getScene())) return null;
    return renderer.raycastScene(x, y, options)?.intersection.point ?? null;
  };
}

/** Both ends of the view ray: a look-around keeps the position but turns it. */
export interface ZoomPoseCamera {
  getPosition(): SurfacePoint;
  getTarget(): SurfacePoint;
}

/**
 * The camera pose as a comparable key. A picked point stays on the cursor ray
 * only while the surface zoom is the sole thing moving the camera (it
 * translates along that ray), so callers record the pose after each surface
 * step and re-pick when anything else (a plain or fast zoom, an orbit, a pan,
 * a look-around) left a different one.
 */
export function cameraPoseKey(c: ZoomPoseCamera): string {
  const p = c.getPosition(), t = c.getTarget();
  return `${p.x},${p.y},${p.z}|${t.x},${t.y},${t.z}`;
}

/**
 * How stale a cached surface pick may get. Past it the scene may have changed
 * under the camera (an element hidden, isolated or streamed in), so the next
 * zoom-in picks afresh. The wheel measures it from its last notch (a pause
 * ends the gesture); the cursorless zoom from the pick itself, so a held
 * SpaceMouse re-picks at this rate rather than never.
 */
export const SURFACE_PICK_IDLE_MS = 400;

/** The part of `Camera` a surface zoom drives. */
export interface SurfaceZoomCamera extends ZoomPoseCamera {
  zoom(
    delta: number,
    addVelocity?: boolean,
    mouseX?: number,
    mouseY?: number,
    canvasWidth?: number,
    canvasHeight?: number,
    fastZoom?: boolean,
    surfacePoint?: SurfacePoint,
  ): void;
}

/**
 * Zoom with no cursor to anchor it (#5924): the toolbar zoom-in and the
 * SpaceMouse dolly. Both zoom along the view axis, so the surface they
 * approach is the one at the centre of `canvas` (CSS px). Zoom-in picks it
 * through the gated {@link createZoomSurfacePicker} and stops short of it;
 * zoom-out and a miss keep the plain zoom, unchanged.
 *
 * The surface step translates the camera along the centre ray, so a pick stays
 * valid while only this zoom moves the camera: it is reused while the pose is
 * the one the last step left and the pick is under
 * {@link SURFACE_PICK_IDLE_MS} old. A SpaceMouse held forward therefore
 * raycasts a few times a second, not once per frame, and a hold that began
 * with no pick (streaming, a miss) picks again while still held; an orbit,
 * pan or other zoom in between forces a re-pick.
 */
export function createCentreSurfaceZoom(
  renderer: ZoomSurfaceRenderer,
  camera: SurfaceZoomCamera & { getOrbitAnchorBounds(): unknown },
  canvas: Pick<HTMLCanvasElement, 'getBoundingClientRect'>,
  getPickOptions: () => ZoomSurfacePickOptions,
): (delta: number) => void {
  const pickSurface = createZoomSurfacePicker(renderer, camera, getPickOptions);
  let last: { point: SurfacePoint | null; pose: string; pickedAt: number } | null = null;
  return (delta) => {
    if (!(delta < 0)) {
      camera.zoom(delta, false);
      return;
    }
    const now = Date.now();
    if (!last || last.pose !== cameraPoseKey(camera) || now - last.pickedAt >= SURFACE_PICK_IDLE_MS) {
      const { width, height } = canvas.getBoundingClientRect();
      last = { point: width > 0 && height > 0 ? pickSurface(width / 2, height / 2) : null, pose: '', pickedAt: now };
    }
    camera.zoom(delta, false, undefined, undefined, undefined, undefined, false, last.point ?? undefined);
    last.pose = cameraPoseKey(camera);
  };
}
