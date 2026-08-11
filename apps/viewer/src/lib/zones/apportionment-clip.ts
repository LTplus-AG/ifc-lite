/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The divergence-theorem clip that zone volume apportionment is built on
 * (issue #2508, item 1). Given an element's world-space triangles and one
 * COMPILED zone box, report the volume of the element inside that box — and,
 * separately, the volume of the whole element by the same sum, so the two are
 * self-consistent to the last bit.
 *
 * Split out of `apportionment.ts`, which owns the public per-element API. The
 * seam is real rather than cosmetic: everything here is arithmetic over
 * triangles against ONE box and knows nothing of zone sets, shares, tolerances
 * or refusals. Nothing in here allocates, and the scratch buffers below are the
 * reason — which is only safe because this module is single-threaded and
 * re-entrant only through `clipPiece`, never across it.
 *
 * ## Why there is no CSG boolean here
 *
 * The obvious implementation is "intersect the mesh with the zone box, then
 * take the volume of the result". That needs a boolean, or a 6-plane clip plus
 * a section CAP — and capping is the hard, fragile part: it has to weld
 * on-plane vertices, chain half-edges into loops, nest them even-odd and CDT
 * them, and it BAILS on non-manifold boundaries.
 *
 * None of that is necessary to get a NUMBER. Apply the divergence theorem with
 * a field whose divergence is the box's own indicator function:
 *
 *     F = (f, 0, 0),   f(x,y,z) = X_[y0,y1](y) * X_[z0,z1](z) * (clamp(x,x0,x1) - x0)
 *     div F = dF/dx   = X_B                      (the indicator of the box B)
 *
 *     V(S n B) = INTEGRAL_S div F dV = SURFACE_INTEGRAL_dS F . n dA
 *              = SUM over triangles of  n_x * INTEGRAL_T f dA
 *
 * The right-hand side only ever touches the ORIGINAL boundary triangles. The
 * cap never appears — we never build the clipped solid, only integrate over
 * the part of each existing triangle that lies in the box's infinite x-prism.
 * F is discontinuous across the y and z slab planes, which is harmless: split S
 * along them and each interior interface has `n` parallel to Y or Z, where
 * `F . n = 0` because F has only an x component. So the interior contributions
 * cancel identically and only the real boundary survives.
 *
 * Per clipped sub-triangle with vector area `a = 0.5*(p1-p0)x(p2-p0)` (which
 * carries both the unit normal and the area), the contribution is `a.x * w`
 * where `w = centroid.x - x0` inside the slab and `w = x1 - x0` beyond it.
 * `a.x` already equals `n_x * area`, so orientation signs take care of
 * themselves.
 *
 * ## What the caller must guarantee
 *
 * The identity is exact for a CLOSED, ORIENTABLE, single-component surface and
 * meaningless without one — the same four clauses
 * `GeometryClosure::is_trustworthy_solid` (#1891/#1993) already requires before
 * the kernel will state an element's volume at all. Measured on
 * `01_Snowdon_Towers_Sample_Structural(1).ifc`, 40% of meshed elements fail
 * that gate, and one of them (an open 12-triangle beam shell) apportioned to
 * -1.071 m3 against a whole of 0.954 m3. So callers pass only elements the
 * kernel proved solid — in the viewer, elements carrying `MeshData.geometryVolume`
 * — and report the rest as "cannot be apportioned" rather than guessing, which
 * is #2199's rule for volume applied here.
 *
 * ## Frames and units
 *
 * Everything here is the VIEWER's world frame: Y-up, metres (see `types.ts`).
 * Zone `size` is FULL extents. `rotationY` is vertical-axis only, so the world
 * -> zone-local map is the same cheap 2-D rotation `geometry.ts` already uses,
 * and it is volume-preserving. Volumes come out in CUBIC METRES; converting to
 * the project's declared unit for display is the caller's job (`lib/units`),
 * never done by hand here.
 *
 * ## Agreement with v1's straddle convention
 *
 * v1 decides "straddles" with a NEGATIVE epsilon (`STRADDLE_PENETRATION_M`) so
 * an element ending exactly on a boundary shared by two tiling takt areas does
 * NOT straddle. Apportionment agrees for free rather than by a matching
 * epsilon: an element that merely abuts a zone has zero-thickness overlap with
 * it, and a zero-thickness intersection has zero volume, so the zone's share is
 * dropped by {@link NEGLIGIBLE_SHARE_REL}. There is no second threshold to keep
 * in sync.
 */

import type { CompiledZone } from './geometry.js';

/**
 * One renderer mesh piece in the viewer's world frame. `positions` is a flat
 * `[x,y,z,...]` buffer with `origin` NOT yet folded in (world = origin +
 * position, the per-element local frame of #1114), and `indices` addresses it
 * by vertex. An element is a LIST of these because `Scene.getMeshDataPieces`
 * returns one per material/colour slice.
 */
export interface ElementMeshPiece {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  origin?: readonly number[] | null;
}

/** Scratch polygon buffers. A triangle clipped by the four side planes has at
 *  most 7 vertices, and the x split adds at most one more; 12 is comfortable
 *  headroom. Module-level so the hot loop allocates nothing. */
const SCRATCH_A = new Float64Array(12 * 3);
const SCRATCH_B = new Float64Array(12 * 3);

/**
 * Clip `srcCount` vertices of `src` against one axis-aligned half-space and
 * write the result into `dst`. Keeps `p[axis] <= limit` when `keepBelow`, else
 * `p[axis] >= limit`. Returns the new vertex count.
 *
 * The edge parameter is clamped to [0, 1] behind a denominator guard, the same
 * hardening the Rust clipper carries (#1155): without it a near-coincident
 * plane extrapolates the cut vertex off the end of the edge.
 */
function clipHalfSpace(
  src: Float64Array,
  srcCount: number,
  dst: Float64Array,
  axis: 0 | 1 | 2,
  limit: number,
  keepBelow: boolean,
): number {
  let out = 0;
  for (let i = 0; i < srcCount; i++) {
    const ai = i * 3;
    const bi = ((i + 1) % srcCount) * 3;
    const av = src[ai + axis]!;
    const bv = src[bi + axis]!;
    const da = keepBelow ? limit - av : av - limit;
    const db = keepBelow ? limit - bv : bv - limit;
    if (da >= 0) {
      dst[out * 3] = src[ai]!;
      dst[out * 3 + 1] = src[ai + 1]!;
      dst[out * 3 + 2] = src[ai + 2]!;
      out++;
    }
    if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
      const denom = da - db;
      let t = Math.abs(denom) > 1e-12 ? da / denom : 0;
      if (!(t > 0)) t = 0;
      else if (t > 1) t = 1;
      dst[out * 3] = src[ai]! + (src[bi]! - src[ai]!) * t;
      dst[out * 3 + 1] = src[ai + 1]! + (src[bi + 1]! - src[ai + 1]!) * t;
      dst[out * 3 + 2] = src[ai + 2]! + (src[bi + 2]! - src[ai + 2]!) * t;
      out++;
    }
  }
  return out;
}

/** Fan-triangulate `poly` and accumulate `a.x * w`. `far` selects the constant
 *  weight `x1 - x0` (the whole slab is behind the polygon) over the in-slab
 *  weight `centroid.x - x0`. */
function accumulate(poly: Float64Array, count: number, x0: number, x1: number, far: boolean): number {
  if (count < 3) return 0;
  let sum = 0;
  const p0x = poly[0]!;
  const p0y = poly[1]!;
  const p0z = poly[2]!;
  for (let i = 1; i + 1 < count; i++) {
    const ii = i * 3;
    const ji = (i + 1) * 3;
    const uy = poly[ii + 1]! - p0y;
    const uz = poly[ii + 2]! - p0z;
    const vy = poly[ji + 1]! - p0y;
    const vz = poly[ji + 2]! - p0z;
    // x component of 0.5 * u x v -- the only component the field needs.
    const ax = 0.5 * (uy * vz - uz * vy);
    if (ax === 0) continue;
    sum += ax * (far ? x1 - x0 : (p0x + poly[ii]! + poly[ji]!) / 3 - x0);
  }
  return sum;
}

/** Accumulate the clipped integral over ONE piece. */
function clipPiece(piece: ElementMeshPiece, zone: CompiledZone): number {
  const { cx, cy, cz, hx, hy, hz, cos, sin } = zone;
  const positions = piece.positions;
  const indices = piece.indices;
  const ox = piece.origin?.[0] ?? 0;
  const oy = piece.origin?.[1] ?? 0;
  const oz = piece.origin?.[2] ?? 0;
  const x0 = -hx;
  const x1 = hx;
  let vol = 0;

  for (let t = 0; t + 2 < indices.length; t += 3) {
    // Transform the triangle into the zone's local frame. Rotating world
    // coordinates INTO the box frame undoes rotationY, i.e. rotate by -angle:
    // cos(-a) = cos(a), sin(-a) = -sin(a) -- the same closed form
    // `isPointInCompiledZone` uses, kept identical so the two never drift.
    let allBelowY = true, allAboveY = true;
    let allBelowZ = true, allAboveZ = true;
    let allBelowX = true;
    let degenerate = false;
    for (let k = 0; k < 3; k++) {
      const vi = indices[t + k]! * 3;
      const wx = positions[vi]! + ox;
      const wy = positions[vi + 1]! + oy;
      const wz = positions[vi + 2]! + oz;
      if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) {
        degenerate = true;
        break;
      }
      const dx = wx - cx;
      const dz = wz - cz;
      const lx = dx * cos + dz * sin;
      const ly = wy - cy;
      const lz = -dx * sin + dz * cos;
      SCRATCH_A[k * 3] = lx;
      SCRATCH_A[k * 3 + 1] = ly;
      SCRATCH_A[k * 3 + 2] = lz;
      if (ly > -hy) allBelowY = false;
      if (ly < hy) allAboveY = false;
      if (lz > -hz) allBelowZ = false;
      if (lz < hz) allAboveZ = false;
      if (lx > x0) allBelowX = false;
    }
    // Whole triangle outside the x-prism, or entirely on the zero-weight side
    // of x0: contributes nothing. (Nothing is rejected for lying beyond x1 --
    // that region carries the constant `x1 - x0` weight and is exactly how a
    // face on the far side accounts for the slab it shadows.)
    if (degenerate || allBelowY || allAboveY || allBelowZ || allAboveZ || allBelowX) continue;

    let count = 3;
    count = clipHalfSpace(SCRATCH_A, count, SCRATCH_B, 1, hy, true);
    if (count < 3) continue;
    count = clipHalfSpace(SCRATCH_B, count, SCRATCH_A, 1, -hy, false);
    if (count < 3) continue;
    count = clipHalfSpace(SCRATCH_A, count, SCRATCH_B, 2, hz, true);
    if (count < 3) continue;
    count = clipHalfSpace(SCRATCH_B, count, SCRATCH_A, 2, -hz, false);
    if (count < 3) continue;
    count = clipHalfSpace(SCRATCH_A, count, SCRATCH_B, 0, x0, false);
    if (count < 3) continue;

    // Split at x1 into the in-slab part (weight centroid.x - x0) and the part
    // beyond it (constant weight x1 - x0). Sutherland-Hodgman keeps a polygon
    // lying EXACTLY on the split plane whole on BOTH sides, which would double
    // that face's contribution -- so a polygon that does not genuinely straddle
    // x1 is routed to one side without being clipped at all. Faces sitting
    // precisely on a boundary shared by two tiling zones are the common case in
    // takt planning, not an edge case.
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < count; i++) {
      const v = SCRATCH_B[i * 3]!;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (mx <= x1) {
      vol += accumulate(SCRATCH_B, count, x0, x1, false);
    } else if (mn >= x1) {
      vol += accumulate(SCRATCH_B, count, x0, x1, true);
    } else {
      const mid = clipHalfSpace(SCRATCH_B, count, SCRATCH_A, 0, x1, true);
      vol += accumulate(SCRATCH_A, mid, x0, x1, false);
      const far = clipHalfSpace(SCRATCH_B, count, SCRATCH_A, 0, x1, false);
      vol += accumulate(SCRATCH_A, far, x0, x1, true);
    }
  }
  return vol;
}

/**
 * Volume (cubic metres) of the closed mesh `pieces` that lies inside `zone`'s
 * oriented box. Signed the same way the mesh's own volume is signed, so a
 * globally inward-wound mesh yields a negative number here AND a negative whole
 * volume — their ratio is still right. {@link apportionElementVolume}
 * normalises the sign; call that unless you want the raw signed integral.
 */
export function clippedVolumeForZone(pieces: readonly ElementMeshPiece[], zone: CompiledZone): number {
  let vol = 0;
  for (const piece of pieces) vol += clipPiece(piece, zone);
  return vol;
}

/**
 * Signed volume of the whole mesh (cubic metres), by the same divergence sum
 * over unclipped triangles.
 *
 * Referenced to the first finite vertex rather than the world origin: for an
 * OPEN surface the divergence sum is translation-VARIANT, and IFC meshes
 * 250-400 m from the project origin with a small crack in them flipped sign
 * outright in the Rust kernel for exactly this reason
 * (`kernel/signed_volume.rs`). Referencing locally does not make an open mesh
 * correct, but it stops a far-from-origin one from being catastrophically
 * wrong. ONE reference point is shared by every piece, so a multi-piece element
 * cannot pick a different lever arm per piece.
 */
export function meshVolume(pieces: readonly ElementMeshPiece[]): number {
  let refX = NaN, refY = NaN, refZ = NaN;
  for (const piece of pieces) {
    if (piece.indices.length < 3) continue;
    const o = piece.indices[0]! * 3;
    const x = piece.positions[o]! + (piece.origin?.[0] ?? 0);
    const y = piece.positions[o + 1]! + (piece.origin?.[1] ?? 0);
    const z = piece.positions[o + 2]! + (piece.origin?.[2] ?? 0);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      refX = x; refY = y; refZ = z;
      break;
    }
  }
  if (!Number.isFinite(refX)) return 0;

  let v6 = 0;
  for (const piece of pieces) {
    const p = piece.positions;
    const idx = piece.indices;
    const ox = (piece.origin?.[0] ?? 0) - refX;
    const oy = (piece.origin?.[1] ?? 0) - refY;
    const oz = (piece.origin?.[2] ?? 0) - refZ;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const ai = idx[t]! * 3, bi = idx[t + 1]! * 3, ci = idx[t + 2]! * 3;
      const ax = p[ai]! + ox, ay = p[ai + 1]! + oy, az = p[ai + 2]! + oz;
      const bx = p[bi]! + ox, by = p[bi + 1]! + oy, bz = p[bi + 2]! + oz;
      const cx = p[ci]! + ox, cy = p[ci + 1]! + oy, cz = p[ci + 2]! + oz;
      const d = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
      if (Number.isFinite(d)) v6 += d;
    }
  }
  return v6 / 6;
}

/** World-space AABB over every piece, or `null` when no finite vertex exists. */
export function piecesAabb(pieces: readonly ElementMeshPiece[]): [number, number, number, number, number, number] | null {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const piece of pieces) {
    const p = piece.positions;
    const ox = piece.origin?.[0] ?? 0;
    const oy = piece.origin?.[1] ?? 0;
    const oz = piece.origin?.[2] ?? 0;
    for (let i = 0; i + 2 < p.length; i += 3) {
      const x = p[i]! + ox, y = p[i + 1]! + oy, z = p[i + 2]! + oz;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
  }
  return Number.isFinite(minX) ? [minX, minY, minZ, maxX, maxY, maxZ] : null;
}
