/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure geometry math utilities for snap detection.
 *
 * All functions are stateless and operate on Vec3 coordinates.
 */

import type { Vec3 } from './raycaster.js';

/**
 * Euclidean distance between two points.
 */
export function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Check if two vectors are approximately equal.
 */
export function vecEquals(a: Vec3, b: Vec3, epsilon: number = 0.0001): boolean {
  return (
    Math.abs(a.x - b.x) < epsilon &&
    Math.abs(a.y - b.y) < epsilon &&
    Math.abs(a.z - b.z) < epsilon
  );
}

/**
 * Get closest point on an edge segment with parameter t (0-1).
 */
export function closestPointOnEdgeWithT(
  point: Vec3,
  v0: Vec3,
  v1: Vec3
): { point: Vec3; distance: number; t: number } {
  const dx = v1.x - v0.x;
  const dy = v1.y - v0.y;
  const dz = v1.z - v0.z;

  const lengthSq = dx * dx + dy * dy + dz * dz;
  if (lengthSq < 0.0000001) {
    // Degenerate edge
    return { point: v0, distance: distance(point, v0), t: 0 };
  }

  // Project point onto line
  const t = Math.max(0, Math.min(1,
    ((point.x - v0.x) * dx + (point.y - v0.y) * dy + (point.z - v0.z) * dz) / lengthSq
  ));

  const closest: Vec3 = {
    x: v0.x + dx * t,
    y: v0.y + dy * t,
    z: v0.z + dz * t,
  };

  return {
    point: closest,
    distance: distance(point, closest),
    t,
  };
}

/**
 * Convert screen-space radius to world-space radius.
 */
export function screenToWorldRadius(
  screenRadius: number,
  dist: number,
  fov: number,
  screenHeight: number
): number {
  // Calculate world height at distance
  const fovRadians = (fov * Math.PI) / 180;
  const worldHeight = 2 * dist * Math.tan(fovRadians / 2);

  // Convert screen pixels to world units
  return (screenRadius / screenHeight) * worldHeight;
}
