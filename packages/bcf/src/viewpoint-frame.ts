/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Translate a BCF viewpoint between coordinate frames (#4806).
 *
 * BCF positions (`CameraViewPoint`, clipping-plane `Location`, line end
 * points, bitmap `Location`) are in the IFC project's world coordinate
 * system. A viewer that draws a georeferenced model near the origin, to keep
 * float precision usable, works in a SHIFTED frame. Writing its camera
 * without adding the shift back puts the camera kilometres away from the
 * building in every other BCF tool, and reading another tool's camera without
 * subtracting it does the same thing in reverse.
 *
 * A translation moves points only. Directions, up vectors, the field of view
 * and the ortho scale are all shift-invariant, so they are copied unchanged.
 */

import type { BCFPoint, BCFViewpoint } from './types.js';
import { bcfToViewerCoords, type ViewerBounds } from './viewpoint.js';

function add(p: BCFPoint, offset: BCFPoint): BCFPoint {
  return { x: p.x + offset.x, y: p.y + offset.y, z: p.z + offset.z };
}

/**
 * Return a copy of `viewpoint` with every positional value moved by `offset`
 * (IFC Z-up, same units as the viewpoint). Pass the frame's offset to go from
 * the shifted frame to world coordinates; pass its negation to go back.
 * Returns `viewpoint` itself when the offset is zero.
 */
export function translateViewpoint(viewpoint: BCFViewpoint, offset: BCFPoint): BCFViewpoint {
  if (offset.x === 0 && offset.y === 0 && offset.z === 0) return viewpoint;
  const out: BCFViewpoint = { ...viewpoint };
  if (viewpoint.perspectiveCamera) {
    out.perspectiveCamera = {
      ...viewpoint.perspectiveCamera,
      cameraViewPoint: add(viewpoint.perspectiveCamera.cameraViewPoint, offset),
    };
  }
  if (viewpoint.orthogonalCamera) {
    out.orthogonalCamera = {
      ...viewpoint.orthogonalCamera,
      cameraViewPoint: add(viewpoint.orthogonalCamera.cameraViewPoint, offset),
    };
  }
  if (viewpoint.clippingPlanes) {
    out.clippingPlanes = viewpoint.clippingPlanes.map((plane) => ({
      ...plane,
      location: add(plane.location, offset),
    }));
  }
  if (viewpoint.lines) {
    out.lines = viewpoint.lines.map((line) => ({
      startPoint: add(line.startPoint, offset),
      endPoint: add(line.endPoint, offset),
    }));
  }
  if (viewpoint.bitmaps) {
    out.bitmaps = viewpoint.bitmaps.map((bitmap) => ({
      ...bitmap,
      location: add(bitmap.location, offset),
    }));
  }
  return out;
}

/**
 * A stored (world) viewpoint, expressed in the shifted render frame a viewer
 * draws in: the inverse of `translateViewpoint(viewpoint, offset)` (#4879).
 *
 * `offset` is the render frame -> world translation (IFC Z-up). Before #4806
 * ifc-lite wrote render-frame cameras, and those files and stored projects
 * still exist. For them, subtracting the offset would throw the camera as far
 * off as the bug did in the other direction. The two readings differ by the
 * whole offset, which is only non-zero past the 10 km large-coordinate
 * threshold, so whichever reading puts the camera nearer `renderBounds` (the
 * loaded model, Y-up render frame) is unambiguous in practice. Without a
 * camera or bounds there is nothing to compare, and the viewpoint is read as
 * the spec says: world.
 */
export function viewpointFromWorld(
  viewpoint: BCFViewpoint,
  offset: BCFPoint,
  renderBounds?: ViewerBounds | null,
): BCFViewpoint {
  if (offset.x === 0 && offset.y === 0 && offset.z === 0) return viewpoint;
  if (isRenderFrameViewpoint(viewpoint, offset, renderBounds)) return viewpoint;
  return translateViewpoint(viewpoint, { x: -offset.x, y: -offset.y, z: -offset.z });
}

function isRenderFrameViewpoint(
  viewpoint: BCFViewpoint,
  offset: BCFPoint,
  bounds: ViewerBounds | null | undefined,
): boolean {
  const eye = (viewpoint.perspectiveCamera ?? viewpoint.orthogonalCamera)?.cameraViewPoint;
  if (!eye || !bounds) return false;
  const asRenderFrame = distanceToBounds(eye, bounds);
  const asWorld = distanceToBounds({ x: eye.x - offset.x, y: eye.y - offset.y, z: eye.z - offset.z }, bounds);
  return asRenderFrame < asWorld;
}

/** Distance from a BCF (Z-up) point to Y-up viewer bounds; 0 inside. */
function distanceToBounds(p: BCFPoint, bounds: ViewerBounds): number {
  const q = bcfToViewerCoords(p);
  const gap = (v: number, min: number, max: number): number => Math.max(min - v, 0, v - max);
  return Math.hypot(
    gap(q.x, bounds.min.x, bounds.max.x),
    gap(q.y, bounds.min.y, bounds.max.y),
    gap(q.z, bounds.min.z, bounds.max.z),
  );
}
