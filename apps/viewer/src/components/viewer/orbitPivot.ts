/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Orbit-pivot choices shared by the mouse and touch gesture handlers.
 *
 * A drag picks its pivot at gesture start: the geometry under the pointer,
 * else the selected entity, else the scene centre. `focusClash` clears the
 * selection on purpose (#1277/#1339), and on a large or outlier model the
 * pointer raycast is skipped outright, so inspecting a clash orbited around
 * the whole model's centre, far from the collided pair (#4806).
 */

import type { ClashResult } from '@ifc-lite/clash';

type Vec3 = { x: number; y: number; z: number };
type Bounds = { min: Vec3; max: Vec3 };

/** The camera surface the scene-centre fallback reads. */
export interface OrbitPivotCamera {
  getOrbitAnchorBounds(): Bounds | null;
  getSceneBounds(): Bounds | null;
  getTarget(): Vec3;
  unprojectToRay(x: number, y: number, width: number, height: number): { origin: Vec3; direction: Vec3 };
}

/**
 * Centre of the focused clash's overlap box, or `null` when no clash is
 * focused or an entity is selected (a selection always wins, on mouse and
 * touch alike). `Clash.bounds` is built from the viewer's render meshes, so it is
 * already in the camera's (render) frame, the same box `frameClashRegion`
 * frames.
 */
export function focusedClashOrbitPivot(state: {
  clashSelectedId: string | null;
  clashResult: ClashResult | null;
}, selectedEntityId: number | null): Vec3 | null {
  if (selectedEntityId !== null || state.clashSelectedId === null || !state.clashResult) return null;
  const clash = state.clashResult.clashes.find((c) => c.id === state.clashSelectedId);
  if (!clash) return null;
  const { min, max } = clash.bounds;
  const pivot = { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 };
  return Number.isFinite(pivot.x) && Number.isFinite(pivot.y) && Number.isFinite(pivot.z) ? pivot : null;
}

/**
 * The pivot when nothing better is known: the scene centre (a stable point on
 * the model, not the drifting camera target, #1107 item 3). On an outlier
 * model (#1394) that is the robust model centre itself; otherwise it is
 * projected onto the pointer ray so the pivot stays under the pointer.
 */
export function sceneAnchorOrbitPivot(
  camera: OrbitPivotCamera,
  x: number,
  y: number,
  width: number,
  height: number,
): Vec3 {
  const anchorBounds = camera.getOrbitAnchorBounds();
  const bounds = anchorBounds ?? camera.getSceneBounds();
  const anchor = bounds
    ? {
        x: (bounds.min.x + bounds.max.x) / 2,
        y: (bounds.min.y + bounds.max.y) / 2,
        z: (bounds.min.z + bounds.max.z) / 2,
      }
    : camera.getTarget();
  // Outlier model: projecting onto the ray would park the pivot in the empty
  // space beside the compact cluster and swing it out of frame.
  if (anchorBounds) return anchor;
  const ray = camera.unprojectToRay(x, y, width, height);
  const d = Math.max(
    1,
    (anchor.x - ray.origin.x) * ray.direction.x
      + (anchor.y - ray.origin.y) * ray.direction.y
      + (anchor.z - ray.origin.z) * ray.direction.z,
  );
  return {
    x: ray.origin.x + ray.direction.x * d,
    y: ray.origin.y + ray.direction.y * d,
    z: ray.origin.z + ray.direction.z * d,
  };
}
