/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Convex cells used to measure mitred roof parts before emitting their IFC clips. */
export type Point = [number, number, number];
export type Polygon = Point[];
export type Polyhedron = Polygon[];
/** Keep n·p >= k. Normals are unit vectors. */
export interface Cut { n: Point; k: number }
export const dot3 = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: Point, b: Point): Point => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const subtract3 = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export function centre(points: readonly Point[]): Point {
  return [0, 1, 2].map(axis => points.reduce((sum, p) => sum + p[axis], 0) / points.length) as Point;
}
export function normaliseCut(n: Point, k: number): Cut {
  const length = Math.hypot(...n);
  if (!(length > 1e-12)) throw new Error('Coincident roof planes have no bisector');
  return { n: n.map(v => v / length) as Point, k: k / length };
}

/** Clip a convex polyhedron. The new cap faces outward, opposite the kept normal. */
export function clipCell(cell: Polyhedron, cut: Cut, tolerance: number): Polyhedron {
  const side = (p: Point) => dot3(cut.n, p) - cut.k;
  const vertices = cell.flat(), sides = vertices.map(side);
  if (sides.every(d => d >= -tolerance)) return cell;
  if (sides.every(d => d <= tolerance)) return [];
  const cap: Point[] = [], result: Polyhedron = [];
  const unique = (p: Point) => { if (!cap.some(q => Math.hypot(...subtract3(p, q)) < tolerance)) cap.push(p); };
  for (const face of cell) {
    const out: Polygon = [];
    for (let i = 0; i < face.length; i++) {
      const p = face[i], q = face[(i + 1) % face.length], sp = side(p), sq = side(q);
      if (sp >= -tolerance) out.push(p);
      if (Math.abs(sp) <= tolerance) unique(p);
      if ((sp > tolerance && sq < -tolerance) || (sp < -tolerance && sq > tolerance)) {
        const t = sp / (sp - sq), hit = p.map((v, axis) => v + (q[axis] - v) * t) as Point;
        out.push(hit); unique(hit);
      }
    }
    if (out.length >= 3) result.push(out);
  }
  if (cap.length >= 3) {
    const c = centre(cap), outward = cut.n.map(v => -v) as Point;
    const axis: Point = Math.abs(outward[0]) < .8 ? [1, 0, 0] : [0, 1, 0];
    const x = cross3(axis, outward), y = cross3(outward, x);
    cap.sort((a, b) => Math.atan2(dot3(subtract3(a, c), y), dot3(subtract3(a, c), x))
      - Math.atan2(dot3(subtract3(b, c), y), dot3(subtract3(b, c), x)));
    result.push(cap);
  }
  return result;
}
export function cellVolume(cell: Polyhedron): number {
  let volume = 0;
  const o = centre(cell.flat());
  for (const face of cell) for (let i = 1; i + 1 < face.length; i++) {
    volume += dot3(subtract3(face[0], o), cross3(subtract3(face[i], o), subtract3(face[i + 1], o))) / 6;
  }
  return Math.abs(volume);
}
/** Area of a cell's skin on n·p=k, measured in its actual plane. */
export function cellPlaneArea(cell: Polyhedron, n: Point, k: number, tolerance: number): number {
  let area = 0;
  for (const face of cell) {
    if (face.some(p => Math.abs(dot3(n, p) - k) > tolerance)) continue;
    for (let i = 1; i + 1 < face.length; i++) {
      area += Math.abs(dot3(n, cross3(subtract3(face[i], face[0]), subtract3(face[i + 1], face[0])))) / 2;
    }
  }
  return area;
}
export function slabCell(outline: readonly [number, number][], height: (p: [number, number]) => number, depth: number): Polyhedron {
  const bottom = outline.map(([x, y]): Point => [x, y, height([x, y])]);
  const top = bottom.map(([x, y, z]): Point => [x, y, z + depth]);
  return [[...bottom].reverse(), top, ...bottom.map((p, i) => {
    const j = (i + 1) % bottom.length;
    return [p, bottom[j], top[j], top[i]];
  })];
}

type Point2 = [number, number];
const turn = (a: Point2, b: Point2, c: Point2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
/** Ear clipping of a validated simple CCW polygon, including collinear boundary vertices. */
export function triangles(outline: readonly Point2[]): Point2[][] {
  const points = [...outline], result: Point2[][] = [];
  const size = Math.max(...points.map(p => Math.hypot(p[0] - points[0][0], p[1] - points[0][1])));
  const eps = size ** 2 * 1e-12;
  while (points.length > 3) {
    let removed = false;
    for (let i = 0; i < points.length; i++) {
      const j = (i + 1) % points.length, k = (i + 2) % points.length;
      const a = points[i], b = points[j], c = points[k], area = turn(a, b, c);
      if (Math.abs(area) <= eps) { points.splice(j, 1); removed = true; break; }
      if (area < 0 || points.some((p, index) => index !== i && index !== j && index !== k
        && turn(a, b, p) >= -eps && turn(b, c, p) >= -eps && turn(c, a, p) >= -eps)) continue;
      result.push([a, b, c]); points.splice(j, 1); removed = true; break;
    }
    if (!removed) throw new Error('Cannot triangulate the roof eaves');
  }
  if (points.length === 3 && turn(points[0], points[1], points[2]) > eps) result.push(points);
  return result;
}

/** Split a convex planar polygon by an affine height difference. */
export function splitPolygon(polygon: Point2[], side: (p: Point2) => number, tolerance: number): Point2[][] {
  const values = polygon.map(side);
  if (values.every(v => v >= -tolerance) || values.every(v => v <= tolerance)) return [polygon];
  return [1, -1].map(sign => {
    const out: Point2[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i], q = polygon[(i + 1) % polygon.length], a = values[i] * sign, b = values[(i + 1) % polygon.length] * sign;
      if (a >= 0) out.push(p);
      if ((a >= 0) !== (b >= 0)) { const t = a / (a - b); out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]); }
    }
    return out;
  }).filter(p => p.length >= 3);
}
