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
