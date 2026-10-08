/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Point2D } from '@ifc-lite/drawing-2d';

export interface ReferenceAffineTriangle {
  vertices: readonly [Point2D, Point2D, Point2D];
  matrix: readonly [number, number, number, number, number, number];
}

/** Map one raster's four corners through the same two clipped triangles in
 * canvas, SVG and the raw PDF raster underlayer. Reject collapsed/nonfinite
 * projected triangles before any renderer receives an invalid transform. */
export function referenceAffineTriangles(corners: readonly Point2D[], width: number, height: number): readonly ReferenceAffineTriangle[] {
  if (corners.length !== 4 || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0
    || corners.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return [];
  const triangles: ReferenceAffineTriangle[] = [];
  for (const second of [false, true]) {
    const a = corners[0], b = corners[second ? 2 : 1], c = corners[second ? 3 : 2];
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (!Number.isFinite(area) || Math.abs(area) < 1e-8) continue;
    const u = second ? { x: b.x - c.x, y: b.y - c.y } : { x: b.x - a.x, y: b.y - a.y };
    const v = second ? { x: c.x - a.x, y: c.y - a.y } : { x: c.x - b.x, y: c.y - b.y };
    const matrix = [u.x / width, u.y / width, v.x / height, v.y / height, a.x, a.y] as const;
    if (matrix.every(Number.isFinite)) triangles.push({ vertices: [a,b,c], matrix });
  }
  return triangles;
}
