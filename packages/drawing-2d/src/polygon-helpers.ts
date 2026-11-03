/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Point2D } from './types.js';

/**
 * Simplify polygon by removing collinear points
 */
export function simplifyPolygon(points: Point2D[], tolerance: number = 0.001): Point2D[] {
  if (points.length < 3) return points;

  const result: Point2D[] = [];

  for (let i = 0; i < points.length; i++) {
    const prev = points[(i - 1 + points.length) % points.length];
    const curr = points[i];
    const next = points[(i + 1) % points.length];

    // Check if current point is on the line between prev and next
    if (!isCollinear(prev, curr, next, tolerance)) {
      result.push(curr);
    }
  }

  return result.length >= 3 ? result : points;
}

/**
 * Check if three points are collinear
 */
function isCollinear(a: Point2D, b: Point2D, c: Point2D, tolerance: number): boolean {
  // Area of triangle formed by the three points
  const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
  return area < tolerance;
}

/**
 * Compute polygon bounds
 */
export function polygonBounds(
  points: Point2D[]
): { min: Point2D; max: Point2D } {
  let minX = Infinity,
    minY = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity;

  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  return {
    min: { x: minX, y: minY },
    max: { x: maxX, y: maxY },
  };
}
