/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Framing: "put the camera on this thing, keeping the direction it already
 * has". Given the current camera state and a point or an AABB, work out the
 * pose to end up in.
 *
 * The ViewCube's *preset* directions are the neighbouring subject and live in
 * `camera-preset-view.ts`: there the direction is dictated by a named face and
 * a rotation cycle rather than inherited from the pose, and the box has to pass
 * its own admission check first. They share the box arithmetic below and the
 * corner fit, which is why `centerOf` and `fitDistanceFor` are exported.
 *
 * Pure by construction — every function here reads `CameraInternalState` and
 * returns a target, and none of them writes to it or touches the tween. That
 * is what keeps this module free of a cycle back into `camera-animation.ts`,
 * which is the one that applies the results. Same shape as
 * `camera-fit-policy.ts`, which is already pure-picker + facade-applier.
 *
 * Its failure story is not the tween's. The tween latches a non-finite
 * *gesture delta* into a velocity that never decays (#2441/#2473); framing
 * takes a non-finite *box* — geometry-derived, and every AABB accumulator in
 * this package hands out an inverted `+Inf/-Inf` sentinel for a mesh with no
 * finite vertices — and writes it into position, target AND `orthoSize`, which
 * `getOrthoSize()` then persists into a saved viewpoint (#2461).
 *
 * **Guard placement.** Each input is validated exactly once, here, and a
 * rejection is `null`. Callers null-check and do nothing else: a second,
 * defensive copy of the same guard in the caller would mean neither copy is
 * load-bearing on its own, and the mutation tests that pin these guards would
 * go quiet while still looking green.
 */

import type { Vec3 } from './types.js';
import type { CameraInternalState } from './camera-state.js';
import { areFiniteNumbers, isUsableBounds, isUsableDistance } from './camera-guards.js';
import { MathUtils, viewBasis } from './math.js';
import { CAMERA_CONSTANTS } from './constants.js';

/** A pose to animate to. `orthoSize` is undefined when the fit should not touch zoom. */
export interface FramingTarget {
  position: Vec3;
  target: Vec3;
  orthoSize?: number;
}

/** As {@link FramingTarget}, plus the fit distance `zoomExtent` reports onward. */
export interface ZoomExtentTarget extends FramingTarget {
  fitDistance: number;
}

/** An axis-aligned box. */
export interface FramingBounds {
  min: Vec3;
  max: Vec3;
}

/** Centre of a box. */
export function centerOf(min: Vec3, max: Vec3): Vec3 {
  return {
    x: (min.x + max.x) / 2,
    y: (min.y + max.y) / 2,
    z: (min.z + max.z) / 2,
  };
}

/** Largest edge length of a box. Local: only the two fits below measure it. */
function maxExtentOf(min: Vec3, max: Vec3): number {
  return Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
}

/**
 * The viewport's width-to-height ratio, or 1 when it carries no usable one.
 *
 * `setAspect` is the only writer and already rejects a non-positive or
 * non-finite ratio, so the substitute is only for a hand-built state — but
 * both fits below key on it, and an `Infinity` would silently drop the
 * horizontal constraint from one while the other substituted.
 */
function usableAspect(state: CameraInternalState): number {
  const aspect = state.camera.aspect;
  return Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
}

/** Smallest half-height in model units that shows every corner of the box. */
function orthoHalfHeightFor(bounds: FramingBounds, axes: ViewAxes, aspect: number): number {
  let half = 0;
  for (const corner of cornerOffsets(bounds)) {
    const h = Math.abs(MathUtils.dot(corner, axes.right));
    const v = Math.abs(MathUtils.dot(corner, axes.up));
    half = Math.max(half, v, h / aspect);
  }
  return half;
}

/**
 * Orthographic half-height that shows the box with `padding` slack, or
 * `undefined` in perspective mode where `orthoSize` is not in play.
 *
 * Corner-based for the same reason {@link fitDistanceFor} is (#3892), and it
 * is the half that decides what an orthographic viewer actually sees: there
 * the standoff sets no scale at all, so a largest-side `orthoSize` cropped the
 * selection on its own. The depth term does not appear — an orthographic
 * projection does not foreshorten — but the obliqueness one does, and in full:
 * down a south-east isometric direction a 20-unit cube reaches 15.9 units
 * above the centre line, against the 10 the largest-side rule allowed.
 */
function orthoSizeFor(
  state: CameraInternalState,
  bounds: FramingBounds,
  axes: ViewAxes,
  padding: number,
): number | undefined {
  if (state.projectionMode !== 'orthographic') return undefined;
  return Math.max(0.01, orthoHalfHeightFor(bounds, axes, usableAspect(state))) * padding;
}

/**
 * The screen axes a fit projects into: unit length and mutually perpendicular.
 *
 * A structural subset of what {@link viewBasis} returns, and the direction
 * convention is its one: `forward` points from the eye TOWARDS the target,
 * which is the negation of `lookAt`'s third row. Handing in the backward axis
 * type-checks and would frame the box from the wrong side.
 */
export interface ViewAxes {
  right: Vec3;
  up: Vec3;
  forward: Vec3;
}

/**
 * The eight corners of a box, as offsets from its own centre.
 *
 * Both fits below need exactly this, and the offset form is what makes the
 * corner arithmetic independent of where the box sits in the world. (The
 * package has other corner walks — `shadow-light-matrix.ts`,
 * `render-section-plane.ts` — but they take tuples and return world points.)
 */
function cornerOffsets(bounds: FramingBounds): Vec3[] {
  const center = centerOf(bounds.min, bounds.max);
  const offsets: Vec3[] = [];
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        offsets.push({ x: x - center.x, y: y - center.y, z: z - center.z });
      }
    }
  }
  return offsets;
}

/**
 * Smallest standoff along `-axes.forward` that puts every corner of the box
 * inside both half-angles, times `padding`. Shared with
 * `camera-preset-view.ts`, which fits the same way from a dictated direction.
 *
 * The distance used to come from the box's largest SIDE, which answers a
 * different question than the projection asks (#3892). Two ways that came
 * apart:
 *
 *  - **Depth.** The near half of the box is closer than its centre, so it
 *    projects bigger than a rule measured at the centre allows for. Head-on
 *    and axis-aligned, a cube of side `s` needs `s/2 / tan + s/2`, not
 *    `s/2 / tan`; at a 60 degree field the old rule cropped it even under the
 *    1.5 padding.
 *  - **Obliqueness.** `frameBoundsTarget` fits along the live view direction,
 *    which is essentially never axis-aligned, and down a diagonal a box
 *    projects wider than any single side of it.
 *
 * Only the corners answer the question, so all eight are walked. A corner's
 * sideways offsets do not depend on the standoff and its depth is
 * `dot(corner, forward) + distance`, so it is inside when
 * `|h| <= tanH * depth` and `|v| <= tanV * depth`; solving each for `distance`
 * and taking the largest satisfies all sixteen constraints at once, because
 * growing the distance only ever relaxes them.
 *
 * Both half-angles bind. The vertical one is `fov / 2` and the horizontal one
 * is `atan(tan(fov / 2) * aspect)`, so on a portrait viewport (`aspect < 1`)
 * the horizontal field is the *narrower* of the two and fitting the vertical
 * field alone would leave the box overflowing left and right. `orthoSizeFor`
 * above has divided by `aspect` for the same reason since it was written, and
 * now walks the same corners.
 *
 * Two fit-distance formulas in this package are deliberately NOT this one:
 * `CameraProjection.fitToBounds` and the compact branch of
 * `camera-fit-policy.ts`, which reproduce the legacy opening pose of every
 * model 1:1 and have tests pinning exactly that. They are a different subject
 * — the initial auto-fit, not "frame what I selected" — and moving them would
 * change the first thing every user sees.
 *
 * The twin of `fitCornersInFrustum` in `packages/bcf/src/ids-camera.ts`
 * (#3882), which fits the same closed form to the BCF camera's one dictated
 * isometric direction. A copy rather than a shared helper because sharing runs
 * the dependency the wrong way — `bcf` does not depend on `renderer`, and this
 * signature is stated in terms of `CameraInternalState`. Keep the arithmetic
 * legible enough that the two read alike.
 */
export function fitDistanceFor(
  state: CameraInternalState,
  bounds: FramingBounds,
  axes: ViewAxes,
  padding: number,
): number {
  const tanV = Math.tan(state.camera.fov / 2);
  const tanH = usableAspect(state) * tanV;

  let distance = 0;
  for (const corner of cornerOffsets(bounds)) {
    const depth = MathUtils.dot(corner, axes.forward);
    const h = Math.abs(MathUtils.dot(corner, axes.right)) / tanH;
    const v = Math.abs(MathUtils.dot(corner, axes.up)) / tanV;
    distance = Math.max(distance, h - depth, v - depth);
  }
  return distance * padding;
}

/**
 * The pose both fits return: the box centred, seen from the direction the
 * camera is already looking in, at the standoff that keeps every corner of it
 * on screen.
 *
 * `frameBounds` and `zoomExtent` differ only in their padding and in what they
 * do with a degenerate box, so the pose itself is built once here. Callers
 * have already run `isUsableBounds` and their own degenerate branch.
 *
 * The direction comes from the pose rather than from `state.viewMatrix`.
 * `frameBoundsTarget` used to read its forward axis as `-(m[8], m[9], m[10])`,
 * which is the world Z axis expressed in CAMERA coordinates, not the camera's
 * world-space backward axis (that is `(m[2], m[6], m[10])`). It is unit
 * length, so neither a finiteness nor a magnitude floor could notice, and it
 * agreed with the pose only for a symmetric rotation — Frame Selection jumped
 * to a mirrored direction on an ordinary orbited pose (#3892).
 *
 * `viewBasis` is the one function that builds this frame, shared with
 * `MathUtils.lookAt` and `unprojectToRay` (#2467). It scrubs non-finite
 * coordinates and substitutes a deterministic basis for a degenerate pose or
 * `up`, so it always returns finite unit axes: the two direction ladders that
 * used to stand in these functions (view matrix, then pose, then a hard-coded
 * isometric) were reimplementing that fallback with less care, and one of them
 * against the wrong vector. The fit needs the `up` axis as well, and only the
 * basis has it.
 */
function fitPoseFor(
  state: CameraInternalState,
  bounds: FramingBounds,
  center: Vec3,
  padding: number,
): ZoomExtentTarget {
  const basis = viewBasis(state.camera.position, state.camera.target, state.camera.up);
  const distance = fitDistanceFor(state, bounds, basis, padding);

  return {
    // The camera sits opposite the direction it looks in.
    position: {
      x: center.x - basis.forward.x * distance,
      y: center.y - basis.forward.y * distance,
      z: center.z - basis.forward.z * distance,
    },
    target: center,
    // orthoSize so the zoom level resets properly in orthographic mode.
    orthoSize: orthoSizeFor(state, bounds, basis, padding),
    // `zoomExtent`'s caller hands this to `CameraProjection.updateNearFarPlanes`.
    fitDistance: distance,
  };
}

/**
 * Frame/center view on a point (keeps current distance and direction).
 * Standard CAD "Frame Selection" behavior.
 */
export function framePointTarget(state: CameraInternalState, point: Vec3): FramingTarget | null {
  // The point is added to the current offset and animated into both
  // `position` and `target`, so a non-finite one destroys the pose. It is
  // externally derived: `zoomToTopic` frames a BCF marker position, which is
  // computed from a file-supplied viewpoint direction (#2461/#2466).
  if (!areFiniteNumbers(point.x, point.y, point.z)) return null;

  // Keep current viewing direction and distance
  const dir = {
    x: state.camera.position.x - state.camera.target.x,
    y: state.camera.position.y - state.camera.target.y,
    z: state.camera.position.z - state.camera.target.z,
  };

  // New position: point + current offset
  return {
    position: {
      x: point.x + dir.x,
      y: point.y + dir.y,
      z: point.z + dir.z,
    },
    target: point,
  };
}

/**
 * Frame selection - zoom to fit bounds while keeping current view direction.
 * This is what "Frame Selection" should do - zoom to fill screen.
 */
export function frameBoundsTarget(state: CameraInternalState, min: Vec3, max: Vec3): FramingTarget | null {
  // Bounds are the upstream input #2450 stopped short of (#2461). They are
  // not caller-authored constants: they come from geometry, and every AABB
  // accumulator in this package starts from `min = +Infinity, max =
  // -Infinity` and only narrows on a comparison — which is false for a
  // non-finite vertex — so a mesh with no finite vertices hands out that
  // inverted sentinel as if it were a real box. `Math.max` picking the
  // largest extent is NaN-transparent, so it reaches `position`, `target`
  // AND `orthoSize`, and `getOrthoSize()` is what a saved viewpoint persists.
  if (!isUsableBounds(min, max)) return null;

  const center = centerOf(min, max);
  const maxSize = maxExtentOf(min, max);

  if (maxSize < 1e-6) {
    // Very small or zero size - just center on it
    return framePointTarget(state, center);
  }

  return fitPoseFor(state, { min, max }, center, CAMERA_CONSTANTS.FRAME_PADDING_MULTIPLIER);
}

/**
 * Zoom to extents: same fit and the same view direction as `frameBounds`, with
 * wider padding and the fit distance reported back to the caller.
 */
export function zoomExtentTarget(state: CameraInternalState, min: Vec3, max: Vec3): ZoomExtentTarget | null {
  // Same input class and same reasoning as `frameBoundsTarget` (#2461).
  if (!isUsableBounds(min, max)) return null;

  const center = centerOf(min, max);
  const maxSize = maxExtentOf(min, max);

  // The standoff the camera already has, which the degenerate-box branch
  // below keeps rather than fitting.
  const currentDistance = Math.sqrt(
    (state.camera.position.x - state.camera.target.x) ** 2 +
    (state.camera.position.y - state.camera.target.y) ** 2 +
    (state.camera.position.z - state.camera.target.z) ** 2,
  );

  // The degenerate box `frameBoundsTarget` has always special-cased and this
  // one did not. `isUsableBounds` deliberately admits `max === min` (a flat
  // wall, a single picked point, a one-element model), and for such a box the
  // fit distance below is *zero* — so `position` is written equal to `target`,
  // a pose that carries no view direction at all and that `MathUtils.lookAt`
  // then has to substitute a whole basis for. Centre on the point at the
  // distance the camera already has, exactly as `frameBounds` does, and report
  // that distance rather than zero.
  //
  // Only when the current offset is usable. When it is not, the pose already
  // has position === target (or is non-finite), so there is no offset to keep
  // and nothing is gained by keeping it. Such a call falls through to the fit,
  // which for a point-sized box returns a zero standoff and so writes
  // `position === target` again — unchanged from before #3892, and the one
  // input for which this function still hands back a pose with no direction in
  // it. `MathUtils.lookAt` substitutes a basis for it downstream.
  if (maxSize < 1e-6 && isUsableDistance(currentDistance, 1e-10)) {
    const framed = framePointTarget(state, center);
    if (framed) return { ...framed, fitDistance: currentDistance };
  }

  return fitPoseFor(state, { min, max }, center, CAMERA_CONSTANTS.ZOOM_EXTENT_PADDING);
}

