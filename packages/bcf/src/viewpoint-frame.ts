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
