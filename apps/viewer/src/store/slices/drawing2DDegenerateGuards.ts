/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Degenerate-annotation guards for the 2D measure, polygon-area, and cloud
 * tools (issue #4197).
 *
 * completeMeasure2D already rejected a click-without-drag measurement via a
 * minimum-distance check; completePolygonArea2D and completeCloudAnnotation2D
 * only checked point *count*, not size, so three coincident/collinear clicks
 * could store a zero-area polygon (a permanent "0.0 cm2" label), and a
 * zero-size cloud could be stored but render as nothing -- cloudPathGenerator.ts
 * already skips edges below MIN_MEASUREMENT_DISTANCE -- while still being
 * selectable and (since #4159) persisted to localStorage.
 *
 * The three guards share one length threshold (1mm, the smallest drag a
 * user's click can plausibly register as intentional) so they agree on what
 * "degenerate" means:
 *  - a measurement is degenerate below that LENGTH;
 *  - a polygon is degenerate below the AREA of a square with that side
 *    (1e-6 m^2) -- this also catches three collinear points, which shoelace
 *    to exactly zero area despite being three distinct clicks;
 *  - a cloud is degenerate when its bounding box's larger DIMENSION is
 *    below that same length, matching the threshold cloudPathGenerator.ts
 *    uses to decide whether an edge is visible at all.
 */

interface Point2D {
  x: number;
  y: number;
}

/** Minimum meaningful length in drawing units (meters): 1mm. */
export const MIN_MEASUREMENT_DISTANCE = 0.001;

/** Minimum meaningful polygon area in drawing units squared (m^2): a 1mm x 1mm square. */
const MIN_POLYGON_AREA = MIN_MEASUREMENT_DISTANCE ** 2;

/** A measurement shorter than a user's smallest plausible drag. */
export const isDegenerateMeasurement = (distance: number): boolean =>
  distance < MIN_MEASUREMENT_DISTANCE;

/** A polygon whose (possibly negative, pre-abs) shoelace area is ~0 -- coincident or collinear points. */
export const isDegenerateArea = (area: number): boolean =>
  Math.abs(area) < MIN_POLYGON_AREA;

/** A cloud whose bounding box is smaller, in both dimensions, than a renderable edge. */
export const isDegenerateCloud = (points: Point2D[]): boolean => {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return Math.max(width, height) < MIN_MEASUREMENT_DISTANCE;
};
