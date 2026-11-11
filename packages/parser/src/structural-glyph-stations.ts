/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where along an edge and over a face glyphs are drawn, and the local frame of
 * each shape. Pure geometry over `ItemShape`; internal to `structural-glyphs.ts`.
 */

import { add, cross, dot, frameFrom, length, normalize, scale, sub, type Frame, type ItemShape, type Vec3 } from './structural-item-geometry.js';

/** Fractions along an edge where a distributed load or support repeats. */
export const EDGE_STATIONS = [0, 0.25, 0.5, 0.75, 1];
/** Lattice fractions over a face's bounding box, per axis (at most 3 x 3 arrows per face). */
const FACE_LATTICE = [1 / 6, 1 / 2, 5 / 6];

export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scale(sub(b, a), t));

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

export function centroid(polygon: readonly Vec3[]): Vec3 {
  return scale(polygon.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3), 1 / polygon.length);
}

/**
 * The local frame of a shape, used for `LOCAL_COORDS` loads and for support
 * orientation along edges and faces. An edge: x along it, z as close to
 * `zHint` (the member's `Axis`, else world Z) as x allows. A face: z its
 * normal, x along its first side.
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
  const n = polygonNormal(shape.polygon);
  return n ? frameFrom(shape.polygon[0], n, sub(shape.polygon[1], shape.polygon[0])) : null;
}

/** Even-odd point-in-polygon in 2D. */
function inside(p: readonly [number, number], poly: readonly (readonly [number, number])[]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * A sparse lattice of points inside a face: up to 3 x 3 over its bounding box
 * in its own plane, keeping those inside the polygon. The centroid when none
 * falls inside (a thin sliver).
 */
export function faceStations(polygon: readonly Vec3[]): Vec3[] {
  const frame = shapeFrame({ kind: 'face', polygon: [...polygon] }, null);
  if (!frame) return [centroid(polygon)];
  const flat = polygon.map((p) => [dot(sub(p, frame.origin), frame.x), dot(sub(p, frame.origin), frame.y)] as const);
  const us = flat.map((p) => p[0]);
  const vs = flat.map((p) => p[1]);
  const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
  const out: Vec3[] = [];
  for (const fu of FACE_LATTICE) {
    for (const fv of FACE_LATTICE) {
      const u = u0 + (u1 - u0) * fu;
      const v = v0 + (v1 - v0) * fv;
      if (inside([u, v], flat)) out.push(add(frame.origin, add(scale(frame.x, u), scale(frame.y, v))));
    }
  }
  return out.length ? out : [centroid(polygon)];
}

/** Where a shape anchors a single marker: the vertex, the edge midpoint, or the face centroid. */
export function shapeCentre(shape: ItemShape): Vec3 {
  if (shape.kind === 'vertex') return shape.point;
  if (shape.kind === 'edge') return lerp(shape.start, shape.end, 0.5);
  return centroid(shape.polygon);
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
