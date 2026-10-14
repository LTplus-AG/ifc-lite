/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The region the cutting planes leave of the model (#7545): the box of what is
 * still on screen. "Zoom to the cut area" frames this.
 *
 * Exact for any number of planes at any angle, and cheap: the model's bounding
 * box is a convex polyhedron, each plane keeps one half-space of it, and the
 * result is that polyhedron clipped by all of them. Its extent is the extent of
 * its VERTICES, and every vertex of the clipped polyhedron is where three of the
 * bounding half-spaces (the box's six faces and the cutting planes) meet: with at
 * most 14 of them that is at most 364 triples, solved and kept when they lie inside
 * all the others. This finds vertices a face-by-face clip cannot, such as the apex
 * where three planes meet inside the box or a kept region that touches no face of
 * the box at all. The face clip (Sutherland–Hodgman) is kept as well, for the
 * degenerate cases where planes coincide and no triple has a unique solution.
 * No mesh is touched.
 */

export interface Aabb {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/** A half-space cut: removed where `(dot(p, normal) - distance) * (flipped ? -1 : 1) > 0`, as the renderer clips. */
export interface CutPlane {
  normal: readonly [number, number, number];
  distance: number;
  flipped: boolean;
}

type P = [number, number, number];

function signedDistance(p: P, plane: CutPlane): number {
  // Positive = kept side, so the polygon clipper below can treat `>= 0` as inside.
  const side = plane.flipped ? -1 : 1;
  return -(p[0] * plane.normal[0] + p[1] * plane.normal[1] + p[2] * plane.normal[2] - plane.distance) * side;
}

function clipPolygon(polygon: P[], plane: CutPlane): P[] {
  const out: P[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const da = signedDistance(a, plane);
    const db = signedDistance(b, plane);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

function boxFaces(b: Aabb): P[][] {
  const { min: lo, max: hi } = b;
  const c = (x: number, y: number, z: number): P => [x, y, z];
  const [x0, y0, z0, x1, y1, z1] = [lo.x, lo.y, lo.z, hi.x, hi.y, hi.z];
  return [
    [c(x0, y0, z0), c(x1, y0, z0), c(x1, y1, z0), c(x0, y1, z0)],
    [c(x0, y0, z1), c(x1, y0, z1), c(x1, y1, z1), c(x0, y1, z1)],
    [c(x0, y0, z0), c(x1, y0, z0), c(x1, y0, z1), c(x0, y0, z1)],
    [c(x0, y1, z0), c(x1, y1, z0), c(x1, y1, z1), c(x0, y1, z1)],
    [c(x0, y0, z0), c(x0, y1, z0), c(x0, y1, z1), c(x0, y0, z1)],
    [c(x1, y0, z0), c(x1, y1, z0), c(x1, y1, z1), c(x1, y0, z1)],
  ];
}

/**
 * The bounding box of `bounds` with every plane in `planes` applied, or null when
 * nothing of it survives (the planes cut the whole model away) or the input is not
 * finite. With no planes it is `bounds` itself.
 *
 * The extent is taken over the clipped faces' vertices. A plane that slices through
 * the box adds its intersection polygon's corners to those vertices (they are the
 * new vertices Sutherland–Hodgman produces on the box's faces), so the result is the
 * true extent of the kept polyhedron, not a looser box.
 */
/** Keep `n . p <= d`, with `n` a unit vector. */
interface Half { n: P; d: number }

function unitHalf(n: readonly [number, number, number], d: number): Half | null {
  const length = Math.hypot(n[0], n[1], n[2]);
  return length > 1e-12 ? { n: [n[0] / length, n[1] / length, n[2] / length], d: d / length } : null;
}

/** The vertices of the polyhedron the half-spaces enclose: every feasible meeting of three bounding planes. */
function polyhedronVertices(halves: readonly Half[], scale: number): P[] {
  const out: P[] = [];
  const eps = 1e-9 * Math.max(1, scale);
  for (let i = 0; i < halves.length; i++) {
    for (let j = i + 1; j < halves.length; j++) {
      for (let k = j + 1; k < halves.length; k++) {
        const a = halves[i]!, b = halves[j]!, c = halves[k]!;
        // Cramer's rule on [a.n; b.n; c.n] p = [a.d; b.d; c.d].
        const det = a.n[0] * (b.n[1] * c.n[2] - b.n[2] * c.n[1]) - a.n[1] * (b.n[0] * c.n[2] - b.n[2] * c.n[0]) + a.n[2] * (b.n[0] * c.n[1] - b.n[1] * c.n[0]);
        if (Math.abs(det) < 1e-9) continue;
        const cross = (u: P, v: P): P => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const bc = cross(b.n, c.n), ca = cross(c.n, a.n), ab = cross(a.n, b.n);
        const p: P = [
          (a.d * bc[0] + b.d * ca[0] + c.d * ab[0]) / det,
          (a.d * bc[1] + b.d * ca[1] + c.d * ab[1]) / det,
          (a.d * bc[2] + b.d * ca[2] + c.d * ab[2]) / det,
        ];
        if (halves.every((h) => h.n[0] * p[0] + h.n[1] * p[1] + h.n[2] * p[2] <= h.d + eps)) out.push(p);
      }
    }
  }
  return out;
}

export function clipBoundsByPlanes(bounds: Aabb, planes: readonly CutPlane[]): Aabb | null {
  const finite = [bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z].every(Number.isFinite);
  if (!finite) return null;
  if (planes.length === 0) return bounds;
  const lo = { x: Infinity, y: Infinity, z: Infinity };
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  let any = false;
  const take = (p: P): void => {
    any = true;
    // `+ 0` turns the -0 a solved vertex can carry into 0.
    const x = p[0] + 0, y = p[1] + 0, z = p[2] + 0;
    lo.x = Math.min(lo.x, x); lo.y = Math.min(lo.y, y); lo.z = Math.min(lo.z, z);
    hi.x = Math.max(hi.x, x); hi.y = Math.max(hi.y, y); hi.z = Math.max(hi.z, z);
  };
  for (const face of boxFaces(bounds)) {
    let polygon = face;
    for (const plane of planes) {
      polygon = clipPolygon(polygon, plane);
      if (polygon.length === 0) break;
    }
    for (const p of polygon) take(p);
  }
  // The vertices a face clip cannot see: where three bounding planes meet inside everything else.
  const { min: m, max: x } = bounds;
  const halves = [
    unitHalf([1, 0, 0], x.x), unitHalf([-1, 0, 0], -m.x), unitHalf([0, 1, 0], x.y), unitHalf([0, -1, 0], -m.y), unitHalf([0, 0, 1], x.z), unitHalf([0, 0, -1], -m.z),
    ...planes.map((plane) => {
      const side = plane.flipped ? -1 : 1; // removed where (n . p - d) * side > 0, so kept is side * n . p <= side * d
      return unitHalf([side * plane.normal[0], side * plane.normal[1], side * plane.normal[2]], side * plane.distance);
    }),
  ].filter((h): h is Half => h !== null);
  const scale = Math.max(Math.abs(m.x), Math.abs(m.y), Math.abs(m.z), Math.abs(x.x), Math.abs(x.y), Math.abs(x.z));
  for (const p of polyhedronVertices(halves, scale)) take(p);
  return any ? { min: lo, max: hi } : null;
}
