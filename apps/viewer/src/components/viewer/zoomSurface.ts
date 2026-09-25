/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The surface a zoom-in approaches (#5393, #5547), shared by every zoom entry
 * point: the wheel (`wheelZoom.ts`, which trackpad pinch also arrives as) and
 * touch pinch (`useTouchControls.ts`). Each picks a point here and hands it to
 * `Camera.zoom(..., surfacePoint)`, which stops short of it instead of passing
 * through thin objects.
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
