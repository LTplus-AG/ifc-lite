/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The world box that survives a section cut, for the page estimate (#2042).
 *
 * DEFECT CLASS this exists to remove — a dialog that refuses a sheet which
 * would print perfectly well. `estimateViewPdfLayout` projects the world AABB
 * of every visible mesh, which is a correct upper bound but a badly loose one
 * the moment a section is active: cutting a 200 m site model down to one 8 m
 * bay leaves the estimate quoting the whole 200 m, so the oversize gate blocks
 * an export whose real page would be a comfortable A3. Refusing in the safe
 * direction is right when the number is unknown, but here it IS knowable
 * cheaply.
 *
 * This clips the box against the SAME half-space `clipMeshToHalfSpace` keeps
 * (`dot(p, normal) <= offset`) and returns the AABB of the result. It stays an
 * upper bound — the clipped box contains the clipped geometry, exactly as the
 * unclipped box contained the unclipped geometry — so the estimate keeps the
 * property the readout promises ("will never be larger"), it just stops being
 * needlessly pessimistic.
 *
 * The result is EXACT for the clipped box rather than a re-fit of the original:
 * the surviving region is the convex hull of the surviving corners plus the
 * points where box edges cross the plane, and both sets are enumerated here.
 * An axis-aligned cut therefore trims the box exactly, and an oblique one
 * (a face-picked plane) trims it to the true extent of the cut polytope.
 */

import type { Vec3, WorldBounds3D } from '@ifc-lite/drawing-2d';

/** The 12 edges of an AABB, as index pairs into the corner order below. */
const BOX_EDGES: readonly (readonly [number, number])[] = [
  [0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3],
  [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7],
];

interface P3 {
  x: number;
  y: number;
  z: number;
}

/** Corner i has bit 0 = x, bit 1 = y, bit 2 = z picking min/max. */
function boxCorners(b: WorldBounds3D): P3[] {
  const xs = [b.min.x, b.max.x];
  const ys = [b.min.y, b.max.y];
  const zs = [b.min.z, b.max.z];
  const out: P3[] = [];
  for (let i = 0; i < 8; i++) {
    out.push({ x: xs[i & 1], y: ys[(i >> 1) & 1], z: zs[(i >> 2) & 1] });
  }
  return out;
}

function dot(p: P3, n: Vec3): number {
  return p.x * n.x + p.y * n.y + p.z * n.z;
}

/**
 * The AABB of `bounds` intersected with the half-space `dot(p, normal) <= offset`.
 *
 * Returns `null` when the cut removes the box entirely — the caller then has
 * nothing to draw, which is a different thing from "the box is unchanged" and
 * must not be conflated with it.
 *
 * `normal` need not be unit length; only the sign and the ratio to `offset`
 * matter, and both are used as given so this cannot disagree with the clipper.
 */
export function clipBoxToHalfSpace(
  bounds: WorldBounds3D,
  normal: Vec3,
  offset: number,
): WorldBounds3D | null {
  const corners = boxCorners(bounds);
  const dist = corners.map((c) => dot(c, normal) - offset);

  const kept: P3[] = [];
  for (let i = 0; i < 8; i++) {
    if (dist[i] <= 0) kept.push(corners[i]);
  }

  // Every edge crossing the plane contributes its crossing point. Without
  // these the box would be shrunk to the surviving CORNERS, which underreports
  // the surviving region and would turn the estimate from an upper bound into
  // a lower one - the one direction it must never go.
  for (const [a, b] of BOX_EDGES) {
    const da = dist[a];
    const db = dist[b];
    if ((da <= 0 && db <= 0) || (da > 0 && db > 0)) continue;
    const t = da / (da - db);
    if (!Number.isFinite(t)) continue;
    kept.push({
      x: corners[a].x + (corners[b].x - corners[a].x) * t,
      y: corners[a].y + (corners[b].y - corners[a].y) * t,
      z: corners[a].z + (corners[b].z - corners[a].z) * t,
    });
  }

  if (kept.length === 0) return null;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of kept) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}
