/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure geometry-reconstruction helpers for `drawing-markup-read.ts`, split
 * out to stay under the ~400-line house limit.
 *
 * Both `symbolic-parse.ts`'s polyline tessellation (`polylineToSegments`)
 * and the Rust fill-ring extractor (`rust/processing/src/symbolic/fill.rs`
 * `extract_curve_ring`) carry a closed `IfcPolyline`'s explicit closing
 * point straight through — the writer (`drawing-markup-geometry.ts`'s
 * `emitMarkupPolyline`) always appends a literal duplicate of the first
 * point when asked to close a ring, and neither reader dedupes it. So a
 * polygon-area's 3 authored vertices come back as 4 tessellated segments
 * (the 4th degenerate, zero-length) and a cloud's 4 rectangle corners come
 * back as a 5-point fill ring. These helpers undo that duplication once,
 * here, rather than in each per-kind reader.
 */

export interface MarkupPoint2D {
  x: number;
  y: number;
}

const CLOSE_EPSILON = 1e-6;

function pointsEqual(a: MarkupPoint2D, b: MarkupPoint2D): boolean {
  return Math.abs(a.x - b.x) < CLOSE_EPSILON && Math.abs(a.y - b.y) < CLOSE_EPSILON;
}

/**
 * Drop a trailing point that duplicates the first (the explicit closing
 * point every closed ring this module reads carries). No-op when the ring
 * isn't explicitly closed that way, so this is safe to apply unconditionally.
 */
export function dedupeClosingPoint(points: readonly MarkupPoint2D[]): MarkupPoint2D[] {
  if (points.length < 3) return [...points];
  const first = points[0];
  const last = points[points.length - 1];
  return pointsEqual(first, last) ? points.slice(0, -1) : [...points];
}

/**
 * Recover a closed polygon's authored vertices from the tessellated
 * `DrawingLine2D` segments `symbolic-parse.ts` produced for it (one segment
 * per polyline edge, in order — see `polylineToSegments`). Each segment's
 * START point is one authored vertex; the closing duplicate is dropped by
 * {@link dedupeClosingPoint}.
 */
export function polygonPointsFromSegmentStarts(
  segments: ReadonlyArray<{ line: { start: MarkupPoint2D } }>,
): MarkupPoint2D[] {
  return dedupeClosingPoint(segments.map((s) => ({ x: s.line.start.x, y: s.line.start.y })));
}

/**
 * Recover ring points from a flattened `AnnotationFill2D.points` buffer
 * (`[x0, y0, x1, y1, …]`), dropping the closing duplicate the same way.
 */
export function polygonPointsFromFillRing(points: Float32Array): MarkupPoint2D[] {
  const out: MarkupPoint2D[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    out.push({ x: points[i], y: points[i + 1] });
  }
  return dedupeClosingPoint(out);
}
