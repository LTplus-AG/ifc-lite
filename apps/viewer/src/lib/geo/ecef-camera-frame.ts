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
 *  - ...and "zero-length" is the wrong question to ask of that cross product.
 *    `posECEF` and `targetECEF` are two ~6.4e6 m points, so an EXACT overhead
 *    pose does not subtract to a direction exactly antiparallel to `up`: the
 *    cancellation leaves ~1e-13 of residue, the cross product is tiny but
 *    NONZERO, and normalising it turns rounding noise into the camera's
 *    `right` axis. Measured over a real ENU anchor, that axis swings 166°
 *    across a 3 mm change in eye altitude — the basemap spinning under a
 *    stationary user, in the one view the map overlay is most used in. The
 *    test is therefore on the ANGLE ({@link MIN_UP_SIN}), the reading
 *    `MathUtils.viewBasis` already takes in `packages/renderer/src/math.ts`.
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

/**
 * Sine of the angle between `up` and the view direction below which `up`
 * carries no usable orientation. Below it the cross product is numerical
 * residue rather than a direction, and normalising residue is what produced
 * the spinning basemap described at the top of this file.
 *
 * 1e-6 is one microradian, the same cut `MathUtils.viewBasis` makes in
 * `packages/renderer/src/math.ts` (stated there as `DEGENERATE_UP_SIN_SQ =
 * 1e-12` on the squared sine). Orders of magnitude tighter than any pose the
 * navigation code produces — the ViewCube top preset deliberately stops
 * 0.01 rad off the pole — so it only ever replaces a basis that was already
 * meaningless.
 *
 * It is a threshold on the ANGLE and never on a length: `up` reaches the
 * bridge from `camera.getUp()`, which is unsanitised public state that a BCF
 * viewpoint restore writes verbatim, so a short-but-valid `up` is a reachable
 * input whose direction is perfectly well defined. Taking the sine off the
 * NORMALISED `up` is what makes that automatic, and it also keeps the test
 * meaningful for an `up` so small that its square underflows to zero.
 */
const MIN_UP_SIN = 1e-6;

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
 * The unit `right` axis the caller's `up` asks for, or `null` when that `up`
 * carries no usable orientation — non-finite, zero-length, or within
 * {@link MIN_UP_SIN} of the view direction.
 *
 * `direction` and the normalised `up` are both unit vectors, so the length of
 * their cross product IS the sine of the angle between them. That is the whole
 * reason the magnitude test can be an angular one without any extra scaling:
 * the normalisation has already divided `|up|` out. `Number.isFinite` is kept
 * alongside the floor because a floor alone admits `Infinity` — the reading
 * this whole file exists to correct — even though both operands being unit
 * makes it unreachable here today.
 */
function requestedRight(direction: Vec3, up: Vec3Like): Vec3 | null {
  const requested = normalize([up.x, up.y, up.z]);
  if (!requested) return null;
  const c = cross(direction, requested);
  const sin = Math.hypot(c[0], c[1], c[2]);
  if (!Number.isFinite(sin) || sin <= MIN_UP_SIN) return null;
  return [c[0] / sin, c[1] / sin, c[2] / sin];
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
  // usable orientation — non-finite, zero, or within a microradian of the view
  // direction (the ordinary plan view).
  //
  // ROLL, when that happens. An `up` parallel to `direction` has no component
  // in the plane roll turns in, so once this branch is taken the roll is not
  // merely hard to recover from `(position, target, up)` — it is not IN
  // `(position, target, up)`. No substitute chosen here can preserve it, and
  // the Earth-fixed seed below is therefore the honest fallback rather than a
  // bug: world Z unless the direction is already close to it, then world Y.
  // Deterministic matters because the frame is rewritten every animation
  // frame, and a substitute that wobbled would spin the basemap while the user
  // held still.
  //
  // The roll IS recoverable one level up, where the viewer-space pose still
  // exists, and that is where it is recovered: `cesium-bridge.syncCamera`
  // resolves `up` through the renderer's own `viewBasis` before rotating it
  // into ECEF, so the substitute the Cesium camera gets is the very axis the
  // IFC image was drawn with rather than an Earth-fixed one that would leave
  // the basemap rotated against the model by the grid convergence. This
  // branch is what remains for a caller that has no viewer space to offer.
  const seed: Vec3 = Math.abs(direction[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const right = requestedRight(direction, up) ?? normalize(cross(direction, seed))!;

  // Re-derive up from the frame so it is exactly orthogonal to the direction
  // even when the caller's up was only approximately so — Cesium rejects a
  // non-orthogonal camera frame outright. `right` and `direction` are unit
  // and orthogonal, so this cross is unit length and cannot fail.
  return { direction, up: normalize(cross(right, direction))!, right };
}
