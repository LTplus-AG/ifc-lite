/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer section plane <-> BCF clipping plane (one plane at a time; `viewpoint.ts` maps a viewpoint's list).
 * Split out of `viewpoint.ts` to keep that module within its size budget.
 */

import type { BCFClippingPlane } from './types.js';
import { bcfToViewerCoords, viewerToBcfCoords, type Point3D, type ViewerBounds, type ViewerSectionPlane } from './viewpoint.js';

// ============================================================================
// Section Plane Conversion
// ============================================================================

/**
 * Convert viewer section plane to BCF clipping plane
 *
 * ifc-lite uses a percentage position along an axis (0-100 spans the bounds;
 * values outside it are cuts beyond them).
 * BCF uses absolute location and direction in world coordinates (Z-up).
 */
export function sectionPlaneToClippingPlane(
  sectionPlane: ViewerSectionPlane,
  bounds: ViewerBounds
): BCFClippingPlane | null {
  if (!sectionPlane.enabled) {
    return null;
  }

  // Calculate absolute position from percentage (in viewer coordinates)
  const t = sectionPlane.position / 100;

  let viewerLocation: Point3D;
  let viewerDirection: Point3D;

  switch (sectionPlane.axis) {
    case 'down': // Y axis (viewer up/down)
      viewerLocation = {
        x: (bounds.min.x + bounds.max.x) / 2,
        y: bounds.min.y + t * (bounds.max.y - bounds.min.y),
        z: (bounds.min.z + bounds.max.z) / 2,
      };
      viewerDirection = sectionPlane.flipped ? { x: 0, y: 1, z: 0 } : { x: 0, y: -1, z: 0 };
      break;

    case 'front': // Z axis (viewer depth)
      viewerLocation = {
        x: (bounds.min.x + bounds.max.x) / 2,
        y: (bounds.min.y + bounds.max.y) / 2,
        z: bounds.min.z + t * (bounds.max.z - bounds.min.z),
      };
      viewerDirection = sectionPlane.flipped ? { x: 0, y: 0, z: 1 } : { x: 0, y: 0, z: -1 };
      break;

    case 'side': // X axis
      viewerLocation = {
        x: bounds.min.x + t * (bounds.max.x - bounds.min.x),
        y: (bounds.min.y + bounds.max.y) / 2,
        z: (bounds.min.z + bounds.max.z) / 2,
      };
      viewerDirection = sectionPlane.flipped ? { x: 1, y: 0, z: 0 } : { x: -1, y: 0, z: 0 };
      break;
  }

  // Convert to BCF coordinates (Z-up)
  return {
    location: viewerToBcfCoords(viewerLocation),
    direction: viewerToBcfCoords(viewerDirection),
  };
}

/**
 * Convert BCF clipping plane to viewer section plane
 *
 * Determines the closest axis and calculates percentage position, unclamped:
 * a location beyond the bounds yields a position below 0 or above 100.
 * Converts from BCF coordinates (Z-up) to viewer coordinates (Y-up).
 */
export function clippingPlaneToSectionPlane(
  plane: BCFClippingPlane,
  bounds: ViewerBounds
): ViewerSectionPlane {
  // Convert from BCF coordinates to viewer coordinates
  const viewerLocation = bcfToViewerCoords(plane.location);
  const viewerDirection = bcfToViewerCoords(plane.direction);

  // Determine primary axis based on direction (in viewer coordinates)
  const absX = Math.abs(viewerDirection.x);
  const absY = Math.abs(viewerDirection.y);
  const absZ = Math.abs(viewerDirection.z);

  let axis: 'down' | 'front' | 'side';
  let position: number;
  let flipped: boolean;

  if (absY >= absX && absY >= absZ) {
    // Y axis dominant (down) in viewer
    axis = 'down';
    const range = bounds.max.y - bounds.min.y;
    position = range > 0 ? ((viewerLocation.y - bounds.min.y) / range) * 100 : 50;
    flipped = viewerDirection.y > 0;
  } else if (absZ >= absX) {
    // Z axis dominant (front) in viewer
    axis = 'front';
    const range = bounds.max.z - bounds.min.z;
    position = range > 0 ? ((viewerLocation.z - bounds.min.z) / range) * 100 : 50;
    flipped = viewerDirection.z > 0;
  } else {
    // X axis dominant (side)
    axis = 'side';
    const range = bounds.max.x - bounds.min.x;
    position = range > 0 ? ((viewerLocation.x - bounds.min.x) / range) * 100 : 50;
    flipped = viewerDirection.x > 0;
  }

  // Not clamped: a location outside the bounds is a legal BCF cut and comes
  // back as a percentage below 0 or above 100, so the cut stays where the
  // viewpoint put it. A non-finite result (a non-finite location) falls back
  // to the midpoint, as a zero-extent axis does.
  if (!Number.isFinite(position)) position = 50;

  return {
    axis,
    position,
    enabled: true,
    flipped,
  };
}
