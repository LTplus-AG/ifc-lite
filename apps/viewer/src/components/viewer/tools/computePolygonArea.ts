/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Polygon area and perimeter computation utilities for 2D annotations.
 * Uses the shoelace formula for area calculation.
 */

interface Point2D {
  x: number;
  y: number;
}

/**
 * Compute the signed area of a simple polygon using the shoelace formula.
 * Returns absolute value (always positive).
 */
export function computePolygonArea(points: Point2D[]): number {
  if (points.length < 3) return 0;
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return Math.abs(area) / 2;
}

/**
 * Compute the perimeter of a closed polygon.
 */
export function computePolygonPerimeter(points: Point2D[]): number {
  if (points.length < 2) return 0;
  let perimeter = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = points[j].x - points[i].x;
    const dy = points[j].y - points[i].y;
    perimeter += Math.sqrt(dx * dx + dy * dy);
  }
  return perimeter;
}

/**
 * Compute the centroid (geometric center) of a polygon.
 */
export function computePolygonCentroid(points: Point2D[]): Point2D {
  if (points.length === 0) return { x: 0, y: 0 };
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  return { x: cx / points.length, y: cy / points.length };
}

/**
 * A room area in square metres at one decimal, whatever its size: the Space
 * Sketch bar and its status line both use it, so an empty draft reads
 * "0.0 m²" in both instead of "0.0 cm²" next to "0.0 m²" (#6233).
 */
export function formatSquareMetres(squareMeters: number): string {
  return `${squareMeters.toFixed(1)} m²`;
}

/**
 * Format an area value for display with appropriate units.
 */
export function formatArea(squareMeters: number): string {
  if (squareMeters < 0.01) {
    return `${(squareMeters * 10000).toFixed(1)} cm²`;
  } else if (squareMeters < 10000) {
    return `${squareMeters.toFixed(2)} m²`;
  } else {
    return `${(squareMeters / 10000).toFixed(2)} ha`;
  }
}
