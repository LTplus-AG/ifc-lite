/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The orthonormal camera frame `cesium-bridge.ts` writes into
 * `viewer.camera.{direction,up,right}` every animation frame, derived from an
 * ECEF position/target/up triple.
 *
 * Split out of the bridge (which is Cesium-heavy and cannot be unit-tested
 * without the whole module) for #2495. The arithmetic never needed Cesium:
 * it is three vectors, a subtraction and two cross products, and pulling it
 * into a zero-dependency leaf follows the same pattern `viewer-enu-rotation.ts`
 * already sets in this directory.
 *
 * What the extraction fixes, beyond making it testable:
 *
 *  - `dirLen < 1e-8` asked about magnitude where finiteness was also at stake.
 *    `Infinity < 1e-8` is false and `NaN < 1e-8` is false, so BOTH sailed past
 *    the "degenerate: target ≡ position" bail-out and `Infinity / Infinity`
 *    then wrote a NaN direction into the Cesium camera. This is the same blind
 *    spot #2489 / #2494 closed inside `packages/renderer`; the bridge is
 *    outside that package and kept it.
 *  - `up` and `right` had NO guard at all. `up` is normalised unconditionally,
 *    and `right = direction × up` is zero-length whenever `up` is parallel to
 *    the view direction — the ordinary straight-down plan view, not an exotic
 *    input. Normalising a zero vector yields NaN, so a plan view wrote a NaN
 *    `right` axis. #2494 made exactly this call for the renderer's billboard
 *    and sky bases: a finite degeneracy that no finiteness guard would catch
 *    wants a deterministic substitute basis, not a floor.
 */

export type Vec3Like = { x: number; y: number; z: number };
export type Vec3 = [number, number, number];

export interface EcefCameraFrame {
  /** Unit view direction (target − position). */
  direction: Vec3;
  /** Unit up axis, orthogonal to `direction`. */
  up: Vec3;
  /** Unit right axis (`direction × up`). */
  right: Vec3;
}

/**
 * Direction has to be long enough that its normalisation is numerically
 * meaningful — an ECEF target within 10nm of the eye is the "target ≡
 * position" case the bridge has always bailed on.
 */
const MIN_DIRECTION_LEN = 1e-8;

function normalize(v: Vec3): Vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  // `len > 0` admits Infinity and returns NaN; only `Number.isFinite` answers
  // the finiteness question. No upper magnitude bound: ECEF coordinates are
  // ~6.4e6 m and a federated site can push the eye far further out.
  if (!Number.isFinite(len) || len === 0) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Build the frame, or `null` when the pose carries no view direction at all
 * (target ≡ position, or a non-finite coordinate anywhere in position/target).
 * `null` means "skip this frame and leave the Cesium camera where it was",
 * which is what the bridge already did for a degenerate direction and what
 * #2461 established as the right response to non-finite camera bounds.
 *
 * A *usable direction with an unusable up* is not a reason to skip: it is the
 * plan view. The up axis is re-derived from the direction in that case, so the
 * frame stays orthonormal and finite and the overlay keeps tracking.
 */
export function ecefCameraFrame(
  position: Vec3Like,
  target: Vec3Like,
  up: Vec3Like,
): EcefCameraFrame | null {
  const delta: Vec3 = [
    target.x - position.x,
    target.y - position.y,
    target.z - position.z,
  ];
  const deltaLen = Math.hypot(delta[0], delta[1], delta[2]);
  if (!Number.isFinite(deltaLen) || deltaLen < MIN_DIRECTION_LEN) return null;
  const direction: Vec3 = [delta[0] / deltaLen, delta[1] / deltaLen, delta[2] / deltaLen];

  // `right = direction × up`. A null here means the caller's up carries no
  // usable direction — non-finite, zero, or parallel to the view direction
  // (the ordinary plan view). Substitute deterministically: world Z unless
  // the direction is already close to it, then world Y. Deterministic matters
  // because the frame is rewritten every animation frame, and a substitute
  // that wobbled would spin the basemap while the user held still.
  const requested = normalize([up.x, up.y, up.z]);
  const seed: Vec3 = Math.abs(direction[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const right = (requested && normalize(cross(direction, requested)))
    ?? normalize(cross(direction, seed))!;

  // Re-derive up from the frame so it is exactly orthogonal to the direction
  // even when the caller's up was only approximately so — Cesium rejects a
  // non-orthogonal camera frame outright. `right` and `direction` are unit
  // and orthogonal, so this cross is unit length and cannot fail.
  return { direction, up: normalize(cross(right, direction))!, right };
}
