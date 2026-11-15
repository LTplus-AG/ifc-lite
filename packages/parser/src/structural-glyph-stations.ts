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

function centroid(polygon: readonly Vec3[]): Vec3 {
  return scale(polygon.reduce((s, p) => add(s, p), [0, 0, 0] as Vec3), 1 / polygon.length);
}

/**
 * The local frame of a shape, used for `LOCAL_COORDS` loads and for support
 * orientation along edges and faces. An edge: x along it, z as close to
 * `zHint` (the member's `Axis`, else world Z) as x allows. A face: its
 * reference surface frame, else z its normal (turned to the side of `zHint`,
 * the owner's placement z, so the winding does not flip it) and x along its
 * first side.
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
  if (!n) return null;
  return frameFrom(shape.polygon[0], zHint && dot(n, zHint) < 0 ? scale(n, -1) : n, sub(shape.polygon[1], shape.polygon[0]));
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

/** Openings exclude their boundary too, avoiding glyphs on a void edge. */
const onFace = (p: readonly [number, number], poly: Flat, holes: readonly Flat[]) =>
  inside(p, poly) && !holes.some((hole) => inside(p, hole) || clearance(p, hole) <= 1e-10);

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
function interiorPoint(poly: Flat, holes: readonly Flat[]): readonly [number, number] {
  return mostOpenPoint(scanlinePoint(poly, holes), poly, holes);
}

/** Cells whose openness the refinement may evaluate (each is one pass over the face's edges), so a long thin face costs a bounded amount. */
const POLE_CELL_BUDGET = 8192;

/** Distance to the nearest edge of the face, positive on it and negative off it. */
const openness = (p: readonly [number, number], poly: Flat, holes: readonly Flat[]): number => {
  const d = Math.min(...[poly, ...holes].map((loop) => clearance(p, loop)));
  return onFace(p, poly, holes) ? d : -d;
};

/**
 * Polylabel-style refinement (#9828): the scanline candidate is inside the face but not always the
 * point farthest from every edge. Rectangular cells of a 16 x 16 grid over the bounds are searched best first, each
 * bounded by its centre's openness plus its half diagonal, and a cell replaces the candidate only when
 * it is more than 0.1% of its openness better, so a candidate already on a plateau (the centre of a
 * band) stays exactly where it is. At most {@link POLE_CELL_BUDGET} cells are evaluated.
 */
function mostOpenPoint(seed: readonly [number, number], poly: Flat, holes: readonly Flat[]): readonly [number, number] {
  let best = seed;
  let bestOpen = openness(seed, poly, holes);
  const margin = bestOpen * 1e-3;
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  if (!(x1 > x0) || !(y1 > y0) || !(margin > 0)) return seed;
  // Rectangular cells, a 16 x 16 grid over the bounds: a long thin face gets cells as thin as itself, so the
  // budget is not spent on cells far outside it.
  type Cell = { x: number; y: number; hx: number; hy: number; open: number; bound: number };
  let evaluated = 0;
  const cell = (x: number, y: number, hx: number, hy: number): Cell => {
    evaluated++;
    const open = openness([x, y], poly, holes);
    return { x, y, hx, hy, open, bound: open + Math.hypot(hx, hy) };
  };
  const [hx0, hy0] = [(x1 - x0) / 32, (y1 - y0) / 32];
  const queue: Cell[] = [];
  for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) queue.push(cell(x0 + hx0 * (2 * i + 1), y0 + hy0 * (2 * j + 1), hx0, hy0));
  // Children are evaluated when made, so the budget counts evaluations (four per cell looked at), not cells looked at.
  while (queue.length && evaluated + 4 <= POLE_CELL_BUDGET) {
    // Best first; ties by position so the result does not depend on insertion order.
    let top = 0;
    for (let i = 1; i < queue.length; i++) {
      const [a, b] = [queue[i], queue[top]];
      if (a.bound > b.bound || (a.bound === b.bound && (a.x < b.x || (a.x === b.x && a.y < b.y)))) top = i;
    }
    const [c] = queue.splice(top, 1);
    if (c.bound <= bestOpen + margin) break;
    if (c.open > bestOpen + margin) { best = [c.x, c.y]; bestOpen = c.open; }
    const [hx, hy] = [c.hx / 2, c.hy / 2];
    for (const [dx, dy] of [[-hx, -hy], [hx, -hy], [-hx, hy], [hx, hy]]) queue.push(cell(c.x + dx, c.y + dy, hx, hy));
  }
  return best;
}

/** The scanline candidate farthest from every edge. */
function scanlinePoint(poly: Flat, holes: readonly Flat[]): readonly [number, number] {
  const heights = [...new Set([poly, ...holes].flatMap((loop) => loop.map((p) => p[1])))].sort((a, b) => a - b);
  let best: readonly [number, number] = poly[0];
  let farthest = -1;
  for (let k = 1; k < heights.length; k++) {
    const v = (heights[k - 1] + heights[k]) / 2;
    const xs = [poly, ...holes].flatMap((loop) => crossings(loop, v)).sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const candidate = [(xs[i] + xs[i + 1]) / 2, v] as const;
      if (!onFace(candidate, poly, holes)) continue;
      const d = Math.min(...[poly, ...holes].map((loop) => clearance(candidate, loop)));
      if (d > farthest) {
        farthest = d;
        best = candidate;
      }
    }
  }
  return best;
}

/** One region of a face in the face's plane. */
type FlatRegion = { flat: Flat; holes: Flat[] };

/** A face in its own plane: the frame, the main region's 2D coordinates in it, and any further regions. Null for a zero-area face. */
function flatten(polygon: readonly Vec3[], innerBounds: readonly Vec3[][] = [], regions: readonly { polygon: Vec3[]; innerBounds: Vec3[][] }[] = []):
  { frame: Frame; flat: Flat; holes: Flat[]; more: FlatRegion[] } | null {
  const frame = shapeFrame({ kind: 'face', polygon: [...polygon] }, null);
  if (!frame) return null;
  const project = (loop: readonly Vec3[]): Flat => loop.map((p) => [dot(sub(p, frame.origin), frame.x), dot(sub(p, frame.origin), frame.y)] as const);
  return { frame, flat: project(polygon), holes: innerBounds.map(project),
    more: regions.map((region) => ({ flat: project(region.polygon), holes: region.innerBounds.map(project) })) };
}

type FlatFace = NonNullable<ReturnType<typeof flatten>>;
/** Whether a point is on any region of a face. */
const onAnyRegion = (p: readonly [number, number], face: FlatFace) =>
  onFace(p, face.flat, face.holes) || face.more.some((region) => onFace(p, region.flat, region.holes));

/**
 * A point on a face: its vertex average when that lies on it, else a scanline
 * point (a notched face). The vertex average for a zero-area face. A face of
 * several regions averages all their vertices, and falls back to its main region.
 */
function faceCentre(polygon: readonly Vec3[], face = flatten(polygon)): Vec3 {
  if (!face) return centroid(polygon);
  const { frame, flat, holes, more } = face;
  const all = [flat, ...more.map((region) => region.flat)].flat();
  const c = [all.reduce((s, p) => s + p[0], 0) / all.length, all.reduce((s, p) => s + p[1], 0) / all.length] as const;
  return pointIn(frame, ...(onAnyRegion(c, face) ? c : interiorPoint(flat, holes)));
}

/**
 * A sparse lattice of points inside a face: up to 3 x 3 over its bounding box
 * in its own plane, keeping those inside a region. One point on the face
 * when none falls inside (a thin sliver or a notched face).
 */
function faceStations(polygon: readonly Vec3[], innerBounds?: Vec3[][], regions?: { polygon: Vec3[]; innerBounds: Vec3[][] }[]): Vec3[] {
  const face = flatten(polygon, innerBounds, regions);
  if (!face) return [centroid(polygon)];
  const { frame, flat, more } = face;
  const all = [flat, ...more.map((region) => region.flat)].flat();
  const us = all.map((p) => p[0]);
  const vs = all.map((p) => p[1]);
  const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
  const out: Vec3[] = [];
  for (const fu of FACE_LATTICE) {
    for (const fv of FACE_LATTICE) {
      const u = u0 + (u1 - u0) * fu;
      const v = v0 + (v1 - v0) * fv;
      if (onAnyRegion([u, v], face)) out.push(pointIn(frame, u, v));
    }
  }
  // A region the lattice missed (regions far apart) still gets a station of its own, a few at most.
  const missed = [{ flat, holes: face.holes }, ...more].filter((region) =>
    !out.some((p) => onFace([dot(sub(p, frame.origin), frame.x), dot(sub(p, frame.origin), frame.y)], region.flat, region.holes)));
  for (const region of missed.slice(0, MISSED_REGION_STATIONS)) {
    if (out.length > 0 || more.length > 0) out.push(pointIn(frame, ...faceRegionCentre(region)));
  }
  return out.length ? out : [faceCentre(polygon, face)];
}

/** At most this many extra stations, one per region the face lattice missed. */
const MISSED_REGION_STATIONS = 9;

/** A point on one region: its vertex average when that lies on it, else a scanline point. */
function faceRegionCentre({ flat, holes }: FlatRegion): readonly [number, number] {
  const c = [flat.reduce((sum, p) => sum + p[0], 0) / flat.length, flat.reduce((sum, p) => sum + p[1], 0) / flat.length] as const;
  return onFace(c, flat, holes) ? c : interiorPoint(flat, holes);
}

/** Where a shape anchors a single marker: the vertex, the edge midpoint, or a point on the face. */
export function shapeCentre(shape: ItemShape): Vec3 {
  if (shape.kind === 'vertex') return shape.point;
  if (shape.kind === 'edge') return lerp(shape.start, shape.end, 0.5);
  return faceCentre(shape.polygon, flatten(shape.polygon, shape.innerBounds, shape.regions));
}

/** Every station of a shape: one vertex, five points along an edge, or the face lattice. */
export function shapeStations(shape: ItemShape): Vec3[] {
  if (shape.kind === 'vertex') return [shape.point];
  if (shape.kind === 'edge') return EDGE_STATIONS.map((t) => lerp(shape.start, shape.end, t));
  return faceStations(shape.polygon, shape.innerBounds, shape.regions);
}

/** A point at (u, v) in a frame's x and y axes (metres). */
export const pointIn = (frame: Frame, u: number, v: number): Vec3 => add(frame.origin, add(scale(frame.x, u), scale(frame.y, v)));

/** A distance along an edge (metres) as a point on it, clamped to its ends. */
export function pointAlong(start: Vec3, end: Vec3, distance: number): Vec3 {
  const l = length(sub(end, start));
  return l > 0 ? lerp(start, end, Math.min(1, Math.max(0, distance / l))) : start;
}

/** Metres a point may lie off a shape and still be on it. */
const ON_SHAPE_TOLERANCE = 1e-3;

/** Whether `p` lies on a shape: at the vertex, on the edge segment, or on the face (in its plane, inside its bounds, off its openings). */
export function onShape(shape: ItemShape, p: Vec3): boolean {
  if (shape.kind === 'vertex') return length(sub(p, shape.point)) <= ON_SHAPE_TOLERANCE;
  if (shape.kind === 'edge') {
    const d = sub(shape.end, shape.start);
    const t = Math.max(0, Math.min(1, dot(sub(p, shape.start), d) / (dot(d, d) || 1)));
    return length(sub(p, lerp(shape.start, shape.end, t))) <= ON_SHAPE_TOLERANCE;
  }
  const face = flatten(shape.polygon, shape.innerBounds, shape.regions);
  if (!face) return false;
  const r = sub(p, face.frame.origin);
  const uv = [dot(r, face.frame.x), dot(r, face.frame.y)] as const;
  return Math.abs(dot(r, face.frame.z)) <= ON_SHAPE_TOLERANCE
    && (onAnyRegion(uv, face) || [face.flat, ...face.more.map((region) => region.flat)].some((ring) => clearance(uv, ring) <= ON_SHAPE_TOLERANCE));
}
