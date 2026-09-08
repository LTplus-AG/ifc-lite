/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure geometry for the multi-click polyline measurement mode (issue #2199).
 *
 * The interaction state machine lives in `measurementSlice.ts`; this module
 * is only the maths — sum-of-segments length and, for a closed loop, the
 * perimeter (the same sum plus the closing segment back to the first point).
 * Both are derived on demand from the stored points, mirroring how
 * `distanceComponents` derives the drag-mode breakdown on render rather than
 * storing it.
 */

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** Euclidean distance between two points, in whatever unit the points use
 *  (renderer/model space is metres throughout — see `formatDistance.ts`). */
export function pointDistance(a: Point3, b: Point3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Sum of the distances between consecutive points. Zero for fewer than two
 * points. Does NOT add a closing segment — see {@link polylineLength} for
 * that.
 */
export function polylineOpenLength(points: readonly Point3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += pointDistance(points[i - 1], points[i]);
  }
  return total;
}

/**
 * The length reported for a finished polyline measurement. `closed` is the
 * basis this number was computed under and must be displayed alongside it:
 * open, this is the path length; closed, it is the perimeter (the open
 * length plus the segment from the last point back to the first).
 */
export function polylineLength(points: readonly Point3[], closed: boolean): number {
  const open = polylineOpenLength(points);
  if (!closed || points.length < 2) return open;
  return open + pointDistance(points[points.length - 1], points[0]);
}

/** Human label for the basis a polyline's `length` was computed under —
 *  read alongside the number rather than leaving the convention implicit. */
export function polylineBasisLabel(closed: boolean): string {
  return closed ? 'Perimeter (closed)' : 'Length';
}
