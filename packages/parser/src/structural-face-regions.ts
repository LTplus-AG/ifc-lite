/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A face whose bounds are all `IfcFaceOuterBound` loops. AxisVM writes a structural slab this way:
 * one face of dozens of outer-bound triangles and no inner bound (#9945). Each loop that lies in no
 * other loop is a region of the face; a loop inside another loop is that loop's opening (a writer
 * that tags an opening as an outer bound), and a loop inside an opening is a region again.
 * Pure geometry in world metres; internal to `structural-item-geometry.ts`.
 */

import { cross, dot, normalize, sub, type Vec3 } from './structural-item-geometry.js';

/** Twice-signed-area magnitude of a ring, from its vector area; zero for a sliver or a line. */
export function ringArea(ring: readonly Vec3[]): number {
  let sum: Vec3 = [0, 0, 0];
  for (let i = 1; i + 1 < ring.length; i++) {
    const c = cross(sub(ring[i], ring[0]), sub(ring[i + 1], ring[0]));
    sum = [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2]];
  }
  return Math.hypot(...sum) / 2;
}

/** One region of a face: its outer ring and the openings in it. */
export interface FaceRegion {
  polygon: Vec3[];
  innerBounds: Vec3[][];
}

type Flat = readonly (readonly [number, number])[];

/** Even-odd point-in-polygon in 2D. */
function inside([x, y]: readonly [number, number], poly: Flat): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Whether a point lies on the boundary of a polygon, to a tolerance relative to its size. */
function onBoundary([x, y]: readonly [number, number], poly: Flat): boolean {
  const scale = Math.max(...poly.flat().map(Math.abs), 1);
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j];
    const [ex, ey] = [poly[i][0] - ax, poly[i][1] - ay];
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1)));
    if (Math.hypot(x - ax - t * ex, y - ay - t * ey) <= 1e-9 * scale) return true;
  }
  return false;
}

/** A point inside a simple polygon: the midpoint of the first span of a scanline between two vertex heights (even-odd). */
function interiorPoint(poly: Flat): readonly [number, number] {
  const heights = [...new Set(poly.map((p) => p[1]))].sort((a, b) => a - b);
  for (let k = 1; k < heights.length; k++) {
    const y = (heights[k - 1] + heights[k]) / 2;
    const xs: number[] = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y)) xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
    }
    xs.sort((a, b) => a - b);
    if (xs.length >= 2 && xs[1] - xs[0] > 1e-12) return [(xs[0] + xs[1]) / 2, y];
  }
  return poly[0];
}

const area = (poly: Flat): number => {
  let twice = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) twice += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return Math.abs(twice) / 2;
};

/**
 * The regions of a face written as `rings`, in file order of their outer rings. One ring is one
 * region. Rings are projected on the plane of the largest one; null when they do not share a plane
 * (or the largest has none), which no planar face does, so the caller keeps its single-polygon reading.
 */
export function faceRegionsOfOuterBounds(rings: readonly Vec3[][]): FaceRegion[] | null {
  if (rings.length < 2) return rings.map((polygon) => ({ polygon, innerBounds: [] }));
  const reference = rings.reduce((best, ring) => (ringArea(ring) > ringArea(best) ? ring : best), rings[0]);
  let normal: Vec3 | null = null;
  for (let i = 1; i + 1 < reference.length && !normal; i++) {
    normal = normalize(cross(sub(reference[i], reference[0]), sub(reference[i + 1], reference[0])));
  }
  const x = normal && normalize(sub(reference[1], reference[0]));
  if (!normal || !x) return null;
  // Every loop must lie in the plane of the reference loop; a loop in another plane would be projected onto it wrongly.
  const extent = Math.max(...reference.map((p) => Math.hypot(...sub(p, reference[0]))), 1e-9);
  if (rings.some((ring) => ring.some((p) => Math.abs(dot(sub(p, reference[0]), normal!)) > 1e-6 * extent + 1e-9))) return null;
  const y = cross(normal, x);
  const flat = rings.map((ring): Flat => ring.map((p) => [dot(sub(p, reference[0]), x), dot(sub(p, reference[0]), y)] as const));
  const areas = flat.map(area);
  // The loops each loop lies in: a larger loop that holds a point inside this one and has no vertex of
  // it outside. The interior point (not the vertex average, which can fall in a notch of a concave
  // loop) rules out a tile that fills a notch of a concave loop with all its vertices on that loop's edge.
  const middle = flat.map(interiorPoint);
  const containers = flat.map((ring, i) => flat.map((_, j) => j).filter((j) => j !== i && areas[j] > areas[i]
    && inside(middle[i], flat[j]) && ring.every((p) => inside(p, flat[j]) || onBoundary(p, flat[j]))));
  const regions = new Map<number, FaceRegion>();
  rings.forEach((polygon, i) => { if (containers[i].length % 2 === 0) regions.set(i, { polygon, innerBounds: [] }); });
  rings.forEach((polygon, i) => {
    if (containers[i].length % 2 === 0) return;
    // An opening belongs to the smallest loop around it.
    const owner = containers[i].reduce((best, j) => (areas[j] < areas[best] ? j : best));
    regions.get(owner)?.innerBounds.push(polygon);
  });
  return [...regions.values()];
}
