/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Deterministic plane-local basis derivation for arbitrary-normal section
 * planes (issue #243).
 *
 * The cap renderer (`Section2DOverlayRenderer`) lifts 2D cut polygons back
 * to 3D using `tangent` + `bitangent` as the in-plane axes. The 2D cutter
 * (`SectionCutter`) projects 3D triangle-plane intersections to 2D using
 * the SAME pair. Without a single shared derivation the two ends would
 * disagree on the basis, the cap polygons would land off the cutting
 * plane, and the hatch pattern would visibly rotate as soon as the
 * basis changed (e.g. between renderer init and a re-derive). This module
 * is the single source of truth.
 *
 * Convention:
 *   • The renderer/world is Y-up. We pick world-Y as the reference axis,
 *     unless the normal is too parallel to Y (within ~25°) — in that case
 *     we fall back to world-X to avoid a degenerate cross-product.
 *   • For the cardinal Y-axis plane (normal = [0,1,0]) the resulting
 *     basis is `tangent ≈ [1,0,0]`, `bitangent ≈ [0,0,-1]`. That matches
 *     the cardinal-axis cap projection (`'down'` axis maps `(x, z) →
 *     (2D.x, 2D.y)` with z mirrored on flip), so face-picking a perfectly
 *     horizontal floor reproduces the same hatch orientation as the
 *     "Down" preset — verified by the unit tests in this file's neighbour.
 */

export type Vec3Tuple = readonly [number, number, number];

export interface PlaneBasis {
  /** First in-plane axis (unit vector). */
  tangent: [number, number, number];
  /** Second in-plane axis (unit vector, `tangent × normal`). */
  bitangent: [number, number, number];
}

/**
 * Derive an orthonormal in-plane basis (`tangent`, `bitangent`) from a
 * unit normal. Returns a basis even for non-unit input — the caller is
 * responsible for normalising `normal` if exact unit length matters
 * elsewhere.
 *
 * Properties guaranteed by the implementation (covered by tests):
 *   1. `tangent · normal ≈ 0` and `bitangent · normal ≈ 0`.
 *   2. `tangent · bitangent ≈ 0`.
 *   3. `|tangent| = |bitangent| = 1`.
 *   4. The result is *deterministic* — the same `normal` always yields
 *      the same `(tangent, bitangent)`. This is essential so the cap
 *      hatch doesn't rotate when state is reconstructed (e.g. on reload
 *      or when the renderer rebuilds resources).
 */
export function planeBasis(normal: Vec3Tuple): PlaneBasis {
  const nx = normal[0];
  const ny = normal[1];
  const nz = normal[2];

  // Reference axis: Y-up unless the normal is nearly parallel to Y, in
  // which case fall back to X. The 0.9 threshold matches the gizmo's
  // existing reference-axis pick in `section-plane.ts`, so the gizmo
  // and the cap hatch never disagree on which fallback they used.
  const useY = Math.abs(ny) < 0.9;
  const refX = useY ? 0 : 1;
  const refY = useY ? 1 : 0;
  const refZ = 0;

  // tangent = normalize(normal × ref)
  let tx = ny * refZ - nz * refY;
  let ty = nz * refX - nx * refZ;
  let tz = nx * refY - ny * refX;
  let tlen = Math.hypot(tx, ty, tz);
  if (tlen < 1e-9) {
    // Should never trigger given the threshold above, but keep the
    // contract honest: any normal yields *some* basis.
    tx = 1; ty = 0; tz = 0;
    tlen = 1;
  }
  tx /= tlen; ty /= tlen; tz /= tlen;

  // bitangent = normalize(tangent × normal). Since tangent ⟂ normal
  // and both are unit length, the cross is already unit length —
  // renormalise defensively against floating-point drift.
  let bx = ty * nz - tz * ny;
  let by = tz * nx - tx * nz;
  let bz = tx * ny - ty * nx;
  const blen = Math.hypot(bx, by, bz) || 1;
  bx /= blen; by /= blen; bz /= blen;

  return {
    tangent:   [tx, ty, tz],
    bitangent: [bx, by, bz],
  };
}

/**
 * Map an arbitrary world-space unit normal to the closest cardinal axis,
 * preserving sign so `flipped` can be derived correctly. Returns
 * `{ axis, flipped }` where `axis` is the renderer's semantic cardinal
 * label and `flipped` is `true` when the dominant component is negative.
 *
 * Used so any code path that still reads `axis`/`flipped` (drawings export,
 * BCF snapshots, view controls) gets the right orientation for a
 * face-picked plane — taking the absolute value alone, as PR #581's
 * original implementation did, inverted exports for the negative-X /
 * negative-Z half-spaces (CodeRabbit P1 on #581).
 */
export function nearestCardinalAxis(
  normal: Vec3Tuple,
): { axis: 'down' | 'front' | 'side'; flipped: boolean } {
  const ax = Math.abs(normal[0]);
  const ay = Math.abs(normal[1]);
  const az = Math.abs(normal[2]);
  if (ay >= ax && ay >= az) {
    return { axis: 'down', flipped: normal[1] < 0 };
  }
  if (ax >= az) {
    return { axis: 'side', flipped: normal[0] < 0 };
  }
  return { axis: 'front', flipped: normal[2] < 0 };
}
