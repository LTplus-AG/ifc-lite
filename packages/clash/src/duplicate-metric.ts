/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The AABB metrics `findDuplicates` matches on: the current distance gate
 * ({@link boxDistance} bounded by `positionTolerance`, preconditioned on
 * {@link boxesTouch}) and the legacy IoU {@link similarity} it superseded,
 * kept only for callers that pass the deprecated `iouThreshold` /
 * `exactThreshold` options. Split out of `duplicates.ts` (which owns the pass
 * itself) to keep both under the ~400-line module limit; not part of the
 * public package surface.
 */

import type { AABB } from '@ifc-lite/spatial';

function aabbVolume(b: AABB): number {
  const dx = Math.max(0, b.max[0] - b.min[0]);
  const dy = Math.max(0, b.max[1] - b.min[1]);
  const dz = Math.max(0, b.max[2] - b.min[2]);
  return dx * dy * dz;
}

/** Intersection-over-union of two AABBs (0 when disjoint). */
function aabbIoU(a: AABB, b: AABB): number {
  const ox = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
  const oy = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]);
  const oz = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]);
  if (ox <= 0 || oy <= 0 || oz <= 0) return 0;
  const inter = ox * oy * oz;
  const union = aabbVolume(a) + aabbVolume(b) - inter;
  return union > 0 ? inter / union : 0;
}

function aabbApproxEqual(a: AABB, b: AABB, tol: number): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(a.min[i] - b.min[i]) > tol) return false;
    if (Math.abs(a.max[i] - b.max[i]) > tol) return false;
  }
  return true;
}

/**
 * Distance (m) between two boxes as *objects*: the largest distance any corner
 * of `a` has to travel to reach the matching corner of `b`. Because the max over
 * the eight corners picks, independently per axis, whichever face moved further,
 * it reduces to the Euclidean norm of the three per-axis face offsets — one
 * square root, no corner enumeration.
 *
 * Two properties make it the tolerance a user can reason about:
 * - **Pure translation gives exactly the translation length.** Every corner
 *   moves by `d`, so the result is `|d|`, whatever the shape and whatever the
 *   direction. That is what makes it isotropic, where IoU was not.
 * - **A size difference counts too.** Concentric boxes whose faces differ by δ
 *   are δ apart, so this is centre distance *and* a shape check in one number,
 *   with no second, dimensionless knob.
 *
 * It is still AABB-only: two elements with the same bounds and different solids
 * inside them are indistinguishable *to this function*. In practice that costs
 * less than it sounds, because real nesting has clearance and clearance is what
 * this measures. An element nested with a gap of `g` on two axes is `g·√2`
 * away, so anything looser than 10/√2 ≈ 7 mm of annulus is rejected outright at
 * the default tolerance — a duct in its shaft and a pipe in a standard sleeve
 * both are. What survives is nesting tighter than that, and the shape signature
 * then keeps it out of `major`. See `findDuplicates` for the measured
 * envelope.
 */
export function boxDistance(a: AABB, b: AABB): number {
  let sum = 0;
  for (let i = 0; i < 3; i += 1) {
    const d = Math.max(Math.abs(a.min[i] - b.min[i]), Math.abs(a.max[i] - b.max[i]));
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Do the boxes touch or overlap on every axis? Two elements that are disjoint
 *  in space are two objects, however close. Without this an element SMALLER than
 *  the tolerance (a 5 mm fixing at a 10 mm tolerance) would pair with a
 *  neighbour it never intersects. Touching (zero gap) counts, so coincident
 *  planar and point geometry still qualifies.
 *
 *  This deliberately excludes one pair the legacy IoU fallback reported: two
 *  zero-thickness sheets offset a few millimetres ALONG THEIR OWN NORMAL are
 *  disjoint (any gap on that axis fails this test), where the old
 *  `aabbApproxEqual` fallback called boxes within `positionTolerance` per axis
 *  the same place. Same reasoning as the 5 mm fixing: geometry with clear air
 *  between the surfaces is two objects, not one modelled twice. Pinned by the
 *  "does not pair two disjoint sheets offset along their own normal" test. */
export function boxesTouch(a: AABB, b: AABB): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (Math.min(a.max[i], b.max[i]) < Math.max(a.min[i], b.min[i])) return false;
  }
  return true;
}

/** Legacy IoU similarity in `[0,1]`, falling back to box-equality for degenerate
 *  (zero-volume / planar) elements where IoU is undefined. */
export function similarity(a: AABB, b: AABB, tol: number): number {
  const iou = aabbIoU(a, b);
  if (iou > 0) return iou;
  // Both (near) degenerate: an exact box match still means "same place".
  if (aabbVolume(a) <= 0 || aabbVolume(b) <= 0) {
    return aabbApproxEqual(a, b, tol) ? 1 : 0;
  }
  return 0;
}

/** Shortest dimension of a box — the depth one element is embedded in another. */
export function minExtent(b: AABB): number {
  return Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
}
