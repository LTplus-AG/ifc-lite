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
 *   • The renderer/world is Y-up. World-Y is the reference axis for every
 *     normal except exactly ±Y, where the cross product vanishes and we
 *     fall back to world-X. `tangent` is therefore horizontal and
 *     `bitangent` never points downward, so a face-picked elevation comes
 *     out upright (#2714).
 *   • For the cardinal Y-axis plane (normal = [0,1,0]) the resulting
 *     basis is `tangent = [0,0,-1]`, `bitangent = [1,0,0]`. That matches
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
 *   6. The result is *continuous* in the normal, everywhere except the two
 *      poles `n = ±Y` (#2714) — nearby normals give nearby bases, so two
 *      face picks on nearly the same face give nearly the same drawing.
 *
 * Normalising up front is what makes 3 and 5 true rather than aspirational
 * (#2489). Before it, the function read the caller's magnitudes directly and
 * every magnitude test below was therefore a test on *length* where the
 * comment claimed an *angle*:
 *   • A non-finite component sailed through both of them — `Infinity > 1e-9`
 *     is true and `NaN < 1e-9` is false — and reached the divisions as
 *     `Infinity / Infinity` / `NaN / NaN`. Both axes came back all-NaN and
 *     went into the section gizmo's vertex buffer and the cap's lift-to-3D.
 *   • The reference-axis pick of the day (`|ny| < 0.9`, since removed for
 *     being discontinuous) only measures the angle to Y when `|normal| = 1`.
 *     `[10, 1, 0]` is 6° off horizontal but was routed down that fallback,
 *     flipping the hatch axis 180° purely because the caller had not
 *     normalised.
 *   • The `1e-9` tangent floor is a length, so a short-but-perfectly-valid
 *     normal such as `[1e-12, 0, 0]` was declared degenerate and returned a
 *     zero-length bitangent.
 * Normalisation keeps the sole remaining fallback below an exact test — it is
 * reachable only for a normal with no direction at all, or one pointing
 * exactly along ±Y.
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

  // Reference axis: world Y, for EVERY normal that is not exactly ±Y. The
  // resulting tangent is `normalize(normal × Ŷ)` — the horizontal in-plane
  // direction — which depends only on the normal's azimuth and is therefore
  // continuous over the whole sphere minus the two poles (#2714).
  //
  // It used to switch to world X at `|ny| >= 0.9` "to avoid a degenerate
  // cross-product", but 0.9 is nowhere near degenerate: the cross is still
  // 0.436 long there. All the switch bought was a JUMP. Measured at the
  // boundary, `ny = 0.8999 → 0.9001` inverted the tangent exactly (dot = -1)
  // at `nz = 0` and rotated it 133 degrees at `nz = 0.3`, and it was
  // asymmetric — the `ny < 0` crossing did not move at all. `|ny| = 0.9` is a
  // plane 25.8 degrees off horizontal, an ordinary ~6:12 roof pitch, and
  // `setSectionPlaneFromFace` reaches it from a face pick: two picks on roof
  // faces straddling that pitch produced drawings rotated 133-180 degrees
  // apart, because this basis IS the drawing's coordinate frame
  // (`useDrawingGeneration` feeds it to the cutter as `customPlane`).
  //
  // No construction can be continuous everywhere — the hairy-ball theorem
  // forbids a nowhere-zero tangent field on a sphere, so at least one normal
  // must be singular. The two poles are the right place for it: `n = ±Y` is
  // an exactly horizontal plane, whose drawing is a plan whose in-plane
  // rotation is a free choice. (The branchless Frisvad/Duff construction gets
  // that down to ONE singular point, but only by winding the frame twice
  // around it, which puts `bitangent · Y = -nx` — i.e. it turns every
  // elevation on one half of the sphere upside down. Two poles is the price
  // of `bitangent · Y = sin(tilt) >= 0` everywhere, which is what keeps
  // face-picked elevations upright.)
  //
  // At the poles themselves the X fallback keeps the historical answer
  // (`planeBasis([0,1,0]) = tangent [0,0,-1], bitangent [1,0,0]`), which is
  // what makes a picked horizontal floor reproduce the "Down" preset's hatch
  // orientation. That value cannot also be the limit from every direction —
  // the frame winds once around the pole, so `[1e-9, 1, 0]` and `[-1e-9, 1, 0]`
  // are 180° apart no matter what is chosen here. That is the singularity, and
  // it is parked where its cost is lowest: the plane is exactly horizontal, so
  // the drawing is a plan and its in-plane rotation carries no meaning.
  const useY = nx !== 0 || nz !== 0;
  const refX = useY ? 0 : 1;
  const refY = useY ? 1 : 0;
  const refZ = 0;

  // tangent = normalize(normal × ref)
  let tx = ny * refZ - nz * refY;
  let ty = nz * refX - nx * refZ;
  let tz = nx * refY - ny * refX;
  let tlen = Math.hypot(tx, ty, tz);
  if (!(tlen > 0)) {
    // Unreachable: `useY` is false only for `n = ±Y`, whose cross with X is
    // exactly unit. Kept so a future edit degrades instead of dividing by
    // zero — and tested as `> 0` rather than against a fixed floor, because
    // any floor here is a re-run of the same defect: `|normal × Ŷ|` is the
    // tilt's sine, so a floor would restore a jump circle at the tilt where
    // it bites.
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
