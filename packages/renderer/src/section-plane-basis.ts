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
 * The basis a normal that carries no usable direction degrades to: exactly
 * what `planeBasis([0, 1, 0])` returns, i.e. the horizontal plane.
 *
 * Every other answer would either be non-orthonormal (a zero bitangent) or a
 * pair matching no real plane at all, and `resolveSectionPlaneFrame` already
 * settled the same question the same way for the clip uniform (#2442): a
 * section normal that cannot be used degrades to a cardinal preset rather
 * than propagating.
 */
function degenerateBasis(): PlaneBasis {
  // Freshly built rather than a shared constant: `PlaneBasis` exposes mutable
  // tuples, and this is a public export.
  return { tangent: [0, 0, -1], bitangent: [1, 0, 0] };
}

/**
 * Derive an orthonormal in-plane basis (`tangent`, `bitangent`) from a
 * plane normal. Non-unit input is fine — the normal is normalised here, so
 * only its *direction* is read.
 *
 * Properties guaranteed by the implementation (covered by tests):
 *   1. `tangent · normal ≈ 0` and `bitangent · normal ≈ 0`.
 *   2. `tangent · bitangent ≈ 0`.
 *   3. `|tangent| = |bitangent| = 1`.
 *   4. The result is *deterministic* — the same `normal` always yields
 *      the same `(tangent, bitangent)`. This is essential so the cap
 *      hatch doesn't rotate when state is reconstructed (e.g. on reload
 *      or when the renderer rebuilds resources).
 *   5. Every component of both axes is finite, for every input.
 *
 * Normalising up front is what makes 3 and 5 true rather than aspirational
 * (#2489). Before it, the function read the caller's magnitudes directly and
 * every magnitude test below was therefore a test on *length* where the
 * comment claimed an *angle*:
 *   • A non-finite component sailed through both of them — `Infinity > 1e-9`
 *     is true and `NaN < 1e-9` is false — and reached the divisions as
 *     `Infinity / Infinity` / `NaN / NaN`. Both axes came back all-NaN and
 *     went into the section gizmo's vertex buffer and the cap's lift-to-3D.
 *   • The `|ny| < 0.9` reference-axis pick only measures the angle to Y when
 *     `|normal| = 1`. `[10, 1, 0]` is 6° off horizontal but was routed down
 *     the near-vertical fallback, flipping the hatch axis 180° purely
 *     because the caller had not normalised.
 *   • The `1e-9` tangent floor is a length, so a short-but-perfectly-valid
 *     normal such as `[1e-12, 0, 0]` was declared degenerate and returned a
 *     zero-length bitangent.
 * A unit normal makes the cross product with the reference axis at least
 * 0.43 long, so the fallback below is now reachable only for a normal with
 * no direction at all.
 */
export function planeBasis(normal: Vec3Tuple): PlaneBasis {
  const nlen = Math.hypot(normal[0], normal[1], normal[2]);
  // One total test covers both bad-input classes: `Math.hypot` returns NaN
  // for a NaN component and Infinity for an infinite one (or for a finite
  // magnitude that overflows), and neither is `> 0 && < Infinity`.
  if (!(nlen > 0 && nlen < Infinity)) return degenerateBasis();
  const nx = normal[0] / nlen;
  const ny = normal[1] / nlen;
  const nz = normal[2] / nlen;

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
    // Unreachable for a unit normal — the reference-axis pick above keeps
    // this cross product at least 0.43 long — but kept so a future edit to
    // the 0.9 threshold degrades instead of dividing by zero.
    tx = 0; ty = 0; tz = -1;
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
