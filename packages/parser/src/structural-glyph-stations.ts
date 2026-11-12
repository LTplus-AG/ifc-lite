/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where along an edge and over a face glyphs are drawn, and the local frame of
 * each shape. Pure geometry over `ItemShape`; internal to `structural-glyphs.ts`.
 */

import { add, cross, dot, frameFrom, length, normalize, scale, sub, type Frame, type ItemShape, type Vec3 } from './structural-item-geometry.js';

/** Fractions along an edge where a distributed load or support repeats. */
const EDGE_STATIONS = [0, 0.25, 0.5, 0.75, 1];
/** Lattice fractions over a face's bounding box, per axis (at most 3 x 3 arrows per face). */
const FACE_LATTICE = [1 / 6, 1 / 2, 5 / 6];

const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scale(sub(b, a), t));

/** Newell normal of a polygon, null when degenerate. */
function polygonNormal(polygon: readonly Vec3[]): Vec3 | null {
  let n: Vec3 = [0, 0, 0];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    n = add(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
  }
  return normalize(n);
}

function centroid(polygon: readonly Vec3[]): Vec3 {
  return scale(polygon.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3), 1 / polygon.length);
}

/**
 * The local frame of a shape, used for `LOCAL_COORDS` loads and for support
 * orientation along edges and faces. An edge: x along it, z as close to
 * `zHint` (the member's `Axis`, else world Z) as x allows. A face: its
 * reference surface frame, else z its normal and x along its first side.
 */
export function shapeFrame(shape: ItemShape, zHint: Vec3 | null): Frame | null {
  if (shape.kind === 'vertex') return null;
  if (shape.kind === 'edge') {
    const x = normalize(sub(shape.end, shape.start));
    if (!x) return null;
    const hint = zHint ?? [0, 0, 1];
    const z = normalize(sub(hint, scale(x, dot(hint, x)))) ?? normalize(cross(x, [0, 1, 0])) ?? [0, 0, 1];
    return { origin: shape.start, x, y: cross(z, x), z };
  }
  if (shape.surface) return shape.surface;
  const n = polygonNormal(shape.polygon);
  return n ? frameFrom(shape.polygon[0], n, sub(shape.polygon[1], shape.polygon[0])) : null;
}

type Flat = readonly (readonly [number, number])[];

/** Where the edges of a 2D polygon cross the line y = v (half-open, so a vertex counts once). */
function crossings(poly: Flat, v: number): number[] {
  const xs: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > v) !== (yj > v)) xs.push(((xj - xi) * (v - yi)) / (yj - yi) + xi);
  }
  return xs;
}

/** Even-odd point-in-polygon in 2D. */
function inside(p: readonly [number, number], poly: Flat): boolean {
  let hit = false;
  for (const x of crossings(poly, p[1])) if (p[0] < x) hit = !hit;
  return hit;
}

/** Distance from a 2D point to the nearest edge of a polygon. */
function clearance([u, v]: readonly [number, number], poly: Flat): number {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j];
    const [ex, ey] = [poly[i][0] - ax, poly[i][1] - ay];
    const t = Math.max(0, Math.min(1, ((u - ax) * ex + (v - ay) * ey) / (ex * ex + ey * ey || 1)));
    d = Math.min(d, Math.hypot(u - ax - t * ex, v - ay - t * ey));
  }
  return d;
}

/**
 * A point inside a 2D polygon of non-zero area, as far from its edges as the
 * candidates allow: the span midpoints of scanlines halfway between adjacent
 * vertex heights. Such a line passes no vertex, so its crossings pair into
 * spans that are inside (even-odd). A row between two heights that differ
 * only by float noise still yields inside candidates and wins only on its
 * real clearance, so a rotated copy of a face may pick another, equally valid
 * anchor.
 */
function interiorPoint(poly: Flat): readonly [number, number] {
  const heights = [...new Set(poly.map((p) => p[1]))].sort((a, b) => a - b);
  let best: readonly [number, number] = poly[0];
  let farthest = -1;
  for (let k = 1; k < heights.length; k++) {
    const v = (heights[k - 1] + heights[k]) / 2;
    const xs = crossings(poly, v).sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const candidate = [(xs[i] + xs[i + 1]) / 2, v] as const;
      const d = clearance(candidate, poly);
      if (d > farthest) {
        farthest = d;
        best = candidate;
      }
    }
  }
  return best;
}

/** A face in its own plane: the frame and the polygon's 2D coordinates in it. Null for a zero-area face. */
function flatten(polygon: readonly Vec3[]): { frame: Frame; flat: Flat } | null {
  const frame = shapeFrame({ kind: 'face', polygon: [...polygon] }, null);
  if (!frame) return null;
  return { frame, flat: polygon.map((p) => [dot(sub(p, frame.origin), frame.x), dot(sub(p, frame.origin), frame.y)] as const) };
}

const lift = (frame: Frame, u: number, v: number): Vec3 => add(frame.origin, add(scale(frame.x, u), scale(frame.y, v)));

/**
 * A point on a face: its vertex average when that lies on it, else a scanline
 * point (a notched face). The vertex average for a zero-area face.
 */
function faceCentre(polygon: readonly Vec3[], face = flatten(polygon)): Vec3 {
  if (!face) return centroid(polygon);
  const { frame, flat } = face;
  const c = [flat.reduce((s, p) => s + p[0], 0) / flat.length, flat.reduce((s, p) => s + p[1], 0) / flat.length] as const;
  return lift(frame, ...(inside(c, flat) ? c : interiorPoint(flat)));
}

/**
 * A sparse lattice of points inside a face: up to 3 x 3 over its bounding box
 * in its own plane, keeping those inside the polygon. One point on the face
 * when none falls inside (a thin sliver or a notched face).
 */
function faceStations(polygon: readonly Vec3[]): Vec3[] {
  const face = flatten(polygon);
  if (!face) return [centroid(polygon)];
  const { frame, flat } = face;
  const us = flat.map((p) => p[0]);
  const vs = flat.map((p) => p[1]);
  const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
  const out: Vec3[] = [];
  for (const fu of FACE_LATTICE) {
    for (const fv of FACE_LATTICE) {
      const u = u0 + (u1 - u0) * fu;
      const v = v0 + (v1 - v0) * fv;
      if (inside([u, v], flat)) out.push(lift(frame, u, v));
    }
  }
  return out.length ? out : [faceCentre(polygon, face)];
}

/** Where a shape anchors a single marker: the vertex, the edge midpoint, or a point on the face. */
export function shapeCentre(shape: ItemShape): Vec3 {
  if (shape.kind === 'vertex') return shape.point;
  if (shape.kind === 'edge') return lerp(shape.start, shape.end, 0.5);
  return faceCentre(shape.polygon);
}

/** Every station of a shape: one vertex, five points along an edge, or the face lattice. */
export function shapeStations(shape: ItemShape): Vec3[] {
  if (shape.kind === 'vertex') return [shape.point];
  if (shape.kind === 'edge') return EDGE_STATIONS.map((t) => lerp(shape.start, shape.end, t));
  return faceStations(shape.polygon);
}

/** A distance along an edge (metres) as a point on it, clamped to its ends. */
export function pointAlong(start: Vec3, end: Vec3, distance: number): Vec3 {
  const l = length(sub(end, start));
  return l > 0 ? lerp(start, end, Math.min(1, Math.max(0, distance / l))) : start;
}
