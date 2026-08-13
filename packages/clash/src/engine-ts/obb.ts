/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Exact penetration depth for the one shape family it can be exact for:
 * rectangular boxes. `maxPenetrationInto` (removed) measured the distance from
 * the nearest crossing-triangle VERTEX to the other surface — an O(edge
 * length) sampling artifact that converges to 0 as a mesh is retessellated,
 * the opposite of what a depth metric should do (see the analytic-oracle
 * fixtures in `obb.test.ts`).
 *
 * This module instead detects when both meshes ARE (within tolerance)
 * axis-independent rectangular boxes and, only then, reports the minimum
 * translation distance along a separating axis — the classical two-OBB
 * penetration depth, which for boxes is provably exact and, because it is
 * derived from the box's face-plane geometry rather than its triangulation,
 * provably unchanged by retessellation. When either mesh is not confirmed to
 * be a box, the caller falls back to the AABB estimate (never a wrong 'mesh'
 * label) — a smaller true thing rather than a large wrong one.
 */

import type { Vec3 } from '../types.js';
import { sub, cross, dot } from '../math/vec3.js';

/** Tolerance for normal-direction dedup and offset-plane clustering. Same
 * literal in the Rust kernel — see `rust/clash/src/obb.rs`. */
export const OBB_EPS = 1e-6;

export interface Obb {
  center: Vec3;
  /** Three mutually orthogonal unit axes. */
  axes: [Vec3, Vec3, Vec3];
  /** Half-extent along each axis, matching `axes` by index. */
  half: [number, number, number];
}

/** Minimal structural view of `TriMesh` this module needs — avoids a
 * circular import between `obb.ts` and `tri-mesh.ts`. */
export interface MeshLike {
  readonly count: number;
  tri(t: number): [Vec3, Vec3, Vec3];
}

function normalize(v: Vec3): Vec3 | null {
  const len = Math.sqrt(dot(v, v));
  if (!(len > OBB_EPS)) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** Flip `n` so its largest-magnitude component is positive, so a face and its
 * antipodal opposite face collapse to the same canonical axis direction. Ties
 * broken in x, y, z order — identical to the Rust `canonical`. */
function canonical(n: Vec3): Vec3 {
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  let idx = 0;
  if (ay > ax && ay >= az) idx = 1;
  else if (az > ax && az > ay) idx = 2;
  return n[idx] < 0 ? [-n[0], -n[1], -n[2]] : n;
}

/**
 * Detect whether `mesh` is a rectangular box: every (non-degenerate)
 * triangle's normal falls into exactly 3 mutually orthogonal canonical
 * directions, and every vertex of the triangles in a direction group lies on
 * one of exactly two offset planes along that direction. That combination —
 * 3 orthogonal face families, 2 planes each — forces the mesh to be a closed
 * rectangular box (it rejects, for example, an axis-aligned L-shape, whose
 * notch adds a third offset plane on two of the axes). Triangulation-
 * independent: subdividing a box's faces adds triangles but never a new
 * canonical direction or a third offset plane, so the detection (and the
 * resulting `Obb`) is identical at any tessellation.
 *
 * Returns `null` — not a best-effort guess — when the check fails, so a
 * caller that only trusts a non-null result never certifies a shape this
 * function could not confirm.
 */
export function detectObb(mesh: MeshLike): Obb | null {
  if (mesh.count === 0) return null;
  const groups: Vec3[] = [];
  const groupOfTri: number[] = new Array(mesh.count).fill(-1);
  for (let t = 0; t < mesh.count; t += 1) {
    const [a, b, c] = mesh.tri(t);
    const n = normalize(cross(sub(b, a), sub(c, a)));
    if (!n) continue; // degenerate triangle: contributes no face-normal evidence
    const cn = canonical(n);
    let gi = -1;
    for (let g = 0; g < groups.length; g += 1) {
      if (dot(groups[g], cn) > 1 - OBB_EPS) {
        gi = g;
        break;
      }
    }
    if (gi === -1) {
      if (groups.length >= 3) return null; // a 4th face-normal family: not a box
      groups.push(cn);
      gi = groups.length - 1;
    }
    groupOfTri[t] = gi;
  }
  if (groups.length !== 3) return null;
  for (let i = 0; i < 3; i += 1) {
    for (let j = i + 1; j < 3; j += 1) {
      if (Math.abs(dot(groups[i], groups[j])) > OBB_EPS) return null;
    }
  }

  const minOff: [number, number, number] = [Infinity, Infinity, Infinity];
  const maxOff: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < mesh.count; t += 1) {
    const gi = groupOfTri[t];
    if (gi === -1) continue;
    const [a, b, c] = mesh.tri(t);
    for (const v of [a, b, c]) {
      const o = dot(v, groups[gi]);
      if (o < minOff[gi]) minOff[gi] = o;
      if (o > maxOff[gi]) maxOff[gi] = o;
    }
  }
  // Reject a 3rd offset plane on any axis (e.g. an L-shaped footprint).
  for (let t = 0; t < mesh.count; t += 1) {
    const gi = groupOfTri[t];
    if (gi === -1) continue;
    const [a, b, c] = mesh.tri(t);
    for (const v of [a, b, c]) {
      const o = dot(v, groups[gi]);
      const scale = Math.max(1, Math.abs(minOff[gi]), Math.abs(maxOff[gi]));
      const nearMin = Math.abs(o - minOff[gi]) <= OBB_EPS * scale;
      const nearMax = Math.abs(o - maxOff[gi]) <= OBB_EPS * scale;
      if (!nearMin && !nearMax) return null;
    }
  }

  const half: [number, number, number] = [0, 0, 0];
  const c0: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    half[i] = (maxOff[i] - minOff[i]) / 2;
    c0[i] = (maxOff[i] + minOff[i]) / 2;
    // Reject a zero-thickness "box": a face family whose triangles are all
    // coplanar passes the 2-plane test above (minOff == maxOff, so both
    // `nearMin` and `nearMax` hold for every vertex) with no positive
    // extent along that axis. An open shell (a slab exported without its
    // top face, or partial `IfcTriangulatedFaceSet` geometry) can produce
    // exactly this — 3 orthogonal families, but one degenerate — and must
    // not be certified as a box (review: #2536).
    if (!(half[i] > OBB_EPS)) return null;
  }
  const center: Vec3 = [
    c0[0] * groups[0][0] + c0[1] * groups[1][0] + c0[2] * groups[2][0],
    c0[0] * groups[0][1] + c0[1] * groups[1][1] + c0[2] * groups[2][1],
    c0[0] * groups[0][2] + c0[1] * groups[1][2] + c0[2] * groups[2][2],
  ];
  return { center, axes: [groups[0], groups[1], groups[2]], half };
}

/**
 * Exact penetration depth between two oriented boxes: the minimum overlap
 * over the 15 canonical OBB-OBB separating-axis candidates (each box's 3 face
 * normals, plus the 9 pairwise cross products of one box's axes with the
 * other's) — the standard result (Gottschalk, "Collision Queries using
 * Oriented Bounding Boxes") that the minimum-translation-distance axis for two
 * boxes is always among these 15. A degenerate cross-product axis (parallel
 * edges) is skipped, not treated as a failure.
 *
 * Returns `null` if any candidate axis reports zero or negative overlap — the
 * boxes would be separated along it, contradicting the caller's own crossing
 * test — so a numerical edge case degrades to `null` (caller falls back to
 * the AABB estimate) rather than reporting a wrong depth.
 */
export function obbPenetrationDepth(a: Obb, b: Obb): number | null {
  const T: Vec3 = [b.center[0] - a.center[0], b.center[1] - a.center[1], b.center[2] - a.center[2]];
  let depth = Infinity;

  function testAxis(L: Vec3): boolean {
    const len = Math.sqrt(dot(L, L));
    if (!(len > OBB_EPS)) return true; // degenerate axis: not a candidate, not a failure
    const u: Vec3 = [L[0] / len, L[1] / len, L[2] / len];
    const rA =
      a.half[0] * Math.abs(dot(a.axes[0], u)) +
      a.half[1] * Math.abs(dot(a.axes[1], u)) +
      a.half[2] * Math.abs(dot(a.axes[2], u));
    const rB =
      b.half[0] * Math.abs(dot(b.axes[0], u)) +
      b.half[1] * Math.abs(dot(b.axes[1], u)) +
      b.half[2] * Math.abs(dot(b.axes[2], u));
    const dist = Math.abs(dot(T, u));
    const overlap = rA + rB - dist;
    if (overlap <= 0) return false;
    if (overlap < depth) depth = overlap;
    return true;
  }

  for (let i = 0; i < 3; i += 1) if (!testAxis(a.axes[i])) return null;
  for (let i = 0; i < 3; i += 1) if (!testAxis(b.axes[i])) return null;
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      if (!testAxis(cross(a.axes[i], b.axes[j]))) return null;
    }
  }
  return depth === Infinity ? null : depth;
}

/** `axes[i]` matched to `v` (parallel within `OBB_EPS`, sign-independent), or
 * `null` if none of the three is. */
function matchAxis(v: Vec3, axes: [Vec3, Vec3, Vec3]): number | null {
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(dot(axes[i], v)) > 1 - OBB_EPS) return i;
  }
  return null;
}

/**
 * Whether `a` and `b` are in a THROUGH-PENETRATION configuration: one box's
 * cross-section, in the plane perpendicular to some shared axis, is fully
 * inside the other's footprint there, while along that axis it extends
 * beyond the other and out the far side — a thin member piercing clean
 * through a wall/slab, not a partial overlap.
 *
 * This matters because {@link obbPenetrationDepth} reports the minimum
 * TRANSLATION distance to separate the pair, which for this shape is
 * dominated by the piercing member's own extent along the shared axis, not
 * by how much material it actually crossed (review: #2536 — a 2 m duct
 * through a 200 mm wall reported 1.1 m, not 0.2 m). Detecting the shape lets
 * the caller decline to certify that number as a measured depth.
 *
 * Only attempted when `a` and `b` share a common frame (every axis of one
 * matches an axis of the other, up to sign and `OBB_EPS`) — the case this
 * reduces to an interval-containment test in that shared frame, and the case
 * the reproduced defect is in (an in-grid MEP member through an in-grid
 * wall). At a generic relative rotation there is no such frame and this
 * returns `false`, leaving {@link obbPenetrationDepth}'s result as-is — a
 * narrower fix than a fully general one, but one that never makes an
 * existing case worse.
 */
export function isThroughPenetration(a: Obb, b: Obb): boolean {
  // `perm[i]` = the index into `b.axes` that matches `a.axes[i]`.
  const perm: number[] = [];
  const used = [false, false, false];
  for (let i = 0; i < 3; i += 1) {
    const j = matchAxis(a.axes[i], b.axes);
    if (j === null || used[j]) return false;
    used[j] = true;
    perm.push(j);
  }

  const d: Vec3 = [b.center[0] - a.center[0], b.center[1] - a.center[1], b.center[2] - a.center[2]];
  // Signed offset between the centres, projected onto each of `a`'s axes —
  // valid because every axis of `b` is parallel to one of `a`'s.
  const offset = [dot(d, a.axes[0]), dot(d, a.axes[1]), dot(d, a.axes[2])];
  const bHalfOnA = [b.half[0], b.half[1], b.half[2]]; // reindexed below
  for (let i = 0; i < 3; i += 1) bHalfOnA[i] = b.half[perm[i]];

  for (let k = 0; k < 3; k += 1) {
    const i = (k + 1) % 3;
    const j = (k + 2) % 3;
    // A pierces B along axis k: A's footprint on the other two axes is
    // STRICTLY inside B's (a real margin, not merely touching edges — two
    // slabs with the identical footprint and different thickness are NOT a
    // piercing member, they are a genuine partial overlap and must keep the
    // measured label), and A extends further than B along k so it is not
    // merely contained — it exits the far side.
    const margin = (h: number) => OBB_EPS * Math.max(1, h);
    const aInsideB =
      Math.abs(offset[i]) + a.half[i] <= bHalfOnA[i] - margin(bHalfOnA[i]) &&
      Math.abs(offset[j]) + a.half[j] <= bHalfOnA[j] - margin(bHalfOnA[j]);
    // "Exits the far side" along k means A's interval extends past B's on
    // BOTH ends, not merely that A's half-extent is the bigger number — a
    // footing embedded 75 mm into a slab from ABOVE is longer than the slab
    // along Z (it does not fit inside it) but only pokes out the TOP, not
    // the bottom, so it is a partial overlap, not a through-penetration.
    // Requiring `a.half[k] > bHalfOnA[k] + |offset[k]|` is exactly "A's
    // interval strictly contains B's interval on axis k", i.e. A pokes out
    // past B on both sides.
    if (aInsideB && a.half[k] > bHalfOnA[k] + Math.abs(offset[k]) + margin(bHalfOnA[k])) return true;
    // B pierces A along axis k: same test with the roles swapped.
    const bInsideA =
      Math.abs(offset[i]) + bHalfOnA[i] <= a.half[i] - margin(a.half[i]) &&
      Math.abs(offset[j]) + bHalfOnA[j] <= a.half[j] - margin(a.half[j]);
    if (bInsideA && bHalfOnA[k] > a.half[k] + Math.abs(offset[k]) + margin(a.half[k])) return true;
  }
  return false;
}
