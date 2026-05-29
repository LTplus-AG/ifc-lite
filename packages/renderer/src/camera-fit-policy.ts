/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Camera-fit policy: pick a target / distance / view direction appropriate
 * to the scene's bounding-box shape.
 *
 * Compact models (typical buildings, aspect <= LINEAR_ASPECT_THRESHOLD) keep
 * the historical south-east isometric pose with `maxSize * 2` distance — the
 * established BIM convention and the only thing the existing test suite has
 * pinned. Long-thin models (railway alignments, road corridors, anything
 * with bbox aspect > 50:1) get a "linear" policy: camera positioned at the
 * bbox centre, looking down-and-along the longest axis, distance chosen so
 * sub-metre features (signals, referents, kerbs) project to several pixels
 * rather than vanishing into a single pixel of the auto-fit frustum.
 *
 * The module is intentionally pure (no GPU / Camera / Renderer dependency)
 * so it can be unit-tested for every aspect ratio that matters and reused
 * by both the post-load auto-fit and the Home-view button without
 * duplicating the heuristic at each call site.
 *
 * iTwin.js civil viewers solve this same problem with a stationing
 * navigation mode that tracks the alignment direction. We approximate the
 * starting pose iTwin uses for the first frame.
 */

import type { Vec3 } from './raycaster.js';

/** Aspect ratio above which a model is treated as linear infrastructure. */
const LINEAR_ASPECT_THRESHOLD = 50;

/**
 * Target on-screen projection for the smallest non-degenerate dim, in
 * pixels. The linear-policy distance is chosen so the shortest meaningful
 * feature (typically the height of signals / referents) lands at roughly
 * this size. Picked to be large enough that anti-aliased sub-pixel features
 * become visibly non-empty without overshooting into a too-close
 * micro-view.
 */
const TARGET_FEATURE_PIXELS = 16;

/** Tilt-down angle when looking along the longest axis, in radians. */
const LINEAR_TILT_RADIANS = (20 * Math.PI) / 180;

/** Smallest viewport dimension to assume when no explicit value is given. */
const DEFAULT_VIEWPORT_SHORT_PX = 640;

export interface Bounds3 {
  min: Vec3;
  max: Vec3;
}

export type FitPolicyKind = 'compact' | 'linear';

export interface FitPolicy {
  /** Which heuristic produced this pose — for telemetry / UI hints. */
  kind: FitPolicyKind;
  /** Bbox aspect ratio (longest / shortest, clamped). Surfaced for tests. */
  aspect: number;
  /** Where the camera should look. */
  target: Vec3;
  /** Where the camera should sit. */
  position: Vec3;
  /** World up vector. Always (0, 1, 0) — both policies are Y-up. */
  up: Vec3;
  /** Distance from position to target. Convenience copy for callers. */
  distance: number;
}

export interface PickFitPolicyOptions {
  /** Vertical field-of-view in radians. */
  fovY: number;
  /** Shortest viewport dimension in pixels (height for landscape). */
  viewportShortPx?: number;
  /**
   * Override the linear-detection threshold. Production should leave this
   * at the default; exposed for tests that pin the threshold behaviour.
   */
  linearAspectThreshold?: number;
}

/**
 * Compute the fit pose for a scene's bounding box. Pure function — no
 * side-effects; returns the pose the caller should apply to the camera.
 *
 * The compact branch reproduces the legacy `fitToBounds()` pose exactly
 * (south-east isometric at `maxSize * 2`) so a model that scored "compact"
 * frames identically to today's build. The linear branch only kicks in
 * once the bbox aspect ratio crosses the threshold, so building / room /
 * piece geometry never sees a behaviour change.
 */
export function pickFitPolicy(
  bounds: Bounds3,
  options: PickFitPolicyOptions,
): FitPolicy {
  const center: Vec3 = {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
    z: (bounds.min.z + bounds.max.z) / 2,
  };
  const sizeX = bounds.max.x - bounds.min.x;
  const sizeY = bounds.max.y - bounds.min.y;
  const sizeZ = bounds.max.z - bounds.min.z;
  const longest = Math.max(sizeX, sizeY, sizeZ);
  const shortest = Math.min(sizeX, sizeY, sizeZ);
  const aspect = longest / Math.max(shortest, longest * 1e-6);
  const threshold = options.linearAspectThreshold ?? LINEAR_ASPECT_THRESHOLD;

  if (aspect <= threshold) {
    // Compact: reproduce the legacy SE isometric pose 1:1 so building
    // models frame exactly as before.
    const distance = longest * 2.0;
    return {
      kind: 'compact',
      aspect,
      target: center,
      position: {
        x: center.x + distance * 0.6,
        y: center.y + distance * 0.5,
        z: center.z + distance * 0.6,
      },
      up: { x: 0, y: 1, z: 0 },
      distance,
    };
  }

  // Linear infrastructure. Position the camera at the bbox centre and
  // look down-and-along the longest axis. The distance is picked so the
  // shortest non-degenerate feature projects to a useful pixel count,
  // capped against the longest axis so we don't recede to a building-scale
  // viewpoint where everything vanishes again.
  const longestAxis = pickLongestUnitAxis(sizeX, sizeY, sizeZ);
  const viewportPx = options.viewportShortPx ?? DEFAULT_VIEWPORT_SHORT_PX;

  // Floor "feature size" against 1% of the longest dim so a pathological
  // shortest = 0 doesn't drive distance to zero. For a 932 × 0.75 × 428
  // railway, featureSize = 0.75 (the actual signal/referent height) which
  // gives a useful close-in pose; for a knife-thin 1000 × 0.001 × 1 model,
  // featureSize = 10 (1% of longest) so we don't end up inside the geometry.
  const featureSize = Math.max(shortest, longest * 0.01);

  const tanHalfFov = Math.tan(options.fovY / 2);
  // Solve `featurePx = featureSize * viewportPx / (2 * distance * tanHalfFov)`
  // for distance, given the target pixel count.
  const distanceForFeature =
    (featureSize * viewportPx) / (2 * TARGET_FEATURE_PIXELS * tanHalfFov);

  // Clamp: at least far enough to clear the longest axis at the edge of
  // the frustum, at most 30% of the longest dim so we still see a usable
  // slice of the alignment instead of one signal.
  const minDistance = (longest * 0.05) / Math.max(tanHalfFov, 0.05);
  const maxDistance = longest * 0.3;
  const distance = clamp(distanceForFeature, Math.min(minDistance, maxDistance), maxDistance);

  // Build a view direction that looks along +longestAxis (so the
  // alignment recedes into the distance) with a 20° downward tilt so the
  // ground plane is visible.
  const up = { x: 0, y: 1, z: 0 };
  const along = longestAxis;
  const tiltCos = Math.cos(LINEAR_TILT_RADIANS);
  const tiltSin = Math.sin(LINEAR_TILT_RADIANS);
  // viewDir = along * cos(tilt) - up * sin(tilt). Camera sits behind the
  // target along the *opposite* of viewDir.
  const viewDir: Vec3 = {
    x: along.x * tiltCos - up.x * tiltSin,
    y: along.y * tiltCos - up.y * tiltSin,
    z: along.z * tiltCos - up.z * tiltSin,
  };
  const position: Vec3 = {
    x: center.x - viewDir.x * distance,
    y: center.y - viewDir.y * distance,
    z: center.z - viewDir.z * distance,
  };

  return {
    kind: 'linear',
    aspect,
    target: center,
    position,
    up,
    distance,
  };
}

function pickLongestUnitAxis(sx: number, sy: number, sz: number): Vec3 {
  if (sx >= sy && sx >= sz) return { x: 1, y: 0, z: 0 };
  if (sz >= sy) return { x: 0, y: 0, z: 1 };
  return { x: 0, y: 1, z: 0 };
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  if (hi < lo) return lo;
  return Math.min(Math.max(value, lo), hi);
}
