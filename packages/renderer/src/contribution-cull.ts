/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Contribution culling: skip draws whose world AABB projects below a pixel
 * threshold on screen. Sub-pixel geometry costs a full draw call + vertex
 * work but contributes at most a flicker of a pixel, so dropping it is
 * visually near-lossless while cutting draw calls and vertex load on large
 * models (issue #1682). The threshold is intentionally raised while the
 * camera is moving: quality matters least mid-gesture, and the cheaper
 * frames keep interaction smooth exactly when the renderer is under the
 * most pressure (same policy as contribution culling in Cesium/xeokit-class
 * viewers).
 *
 * The math is a bounding-sphere estimate (half the AABB diagonal projected
 * at the sphere centre's VIEW DEPTH, not its Euclidean distance — depth is
 * what perspective projection divides by, so off-axis geometry is not
 * under-sized). It is exact for a sphere on the view axis and over-estimates
 * boxes elsewhere, except for one residual: the radial stretch of far-corner
 * perspective projection can exceed the estimate by at most 1/cos(theta) of
 * the diagonal half-FOV (~1.7x at fov 60). With the sub-pixel default
 * thresholds that residual stays visually lossless; treat the threshold as a
 * perceptual heuristic, not a hard guarantee.
 */

export interface ContributionCullOptions {
  /**
   * Projected AABB radius in device pixels below which a draw is skipped
   * while the camera is at rest. `<= 0` disables contribution culling.
   */
  pixelRadius: number;
  /**
   * Threshold while the camera is interacting/animating. Defaults to
   * `pixelRadius` (no motion boost). Values below `pixelRadius` are
   * clamped up to it — motion must never cull LESS than rest.
   */
  interactingPixelRadius?: number;
}

/** Camera state snapshot needed to project an AABB radius to pixels. */
export interface CullCameraState {
  /** Camera eye position in world space. */
  eye: { x: number; y: number; z: number };
  /** Normalized view direction (eye toward target), perspective mode. */
  viewDir: { x: number; y: number; z: number };
  mode: 'perspective' | 'orthographic';
  /** Vertical field of view in radians (perspective mode). */
  fovYRadians: number;
  /** Half the vertical world-space extent of the view volume (orthographic mode). */
  orthoHalfHeight: number;
  /** Canvas height in device pixels. */
  viewportHeightPx: number;
}

/**
 * Resolve the active pixel threshold for this frame.
 * Returns 0 when culling is disabled (absent options or non-positive radius).
 */
export function resolveContributionThresholdPx(
  options: ContributionCullOptions | undefined,
  interacting: boolean,
): number {
  if (!options || !(options.pixelRadius > 0)) return 0;
  if (!interacting) return options.pixelRadius;
  const moving = options.interactingPixelRadius ?? options.pixelRadius;
  return Math.max(options.pixelRadius, moving);
}

/**
 * Projected radius of a world-space AABB, in device pixels.
 *
 * Uses the AABB's bounding sphere (radius = half diagonal). In perspective
 * mode the sphere is projected at the box centre's VIEW DEPTH (distance
 * along `viewDir`), so off-axis boxes never read smaller than an on-axis
 * box at the same depth. When the sphere reaches the camera plane
 * (depth <= radius: camera inside, beside, or behind-but-overlapping),
 * `Infinity` is returned and the caller never culls — a box fully behind
 * the camera is the frustum test's job, not this one's. Degenerate/empty
 * bounds project to 0 and are culled at any positive threshold.
 */
export function projectedAabbRadiusPx(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  cam: CullCameraState,
): number {
  const dx = max[0] - min[0];
  const dy = max[1] - min[1];
  const dz = max[2] - min[2];
  // Half of the AABB diagonal = bounding-sphere radius.
  const radius = 0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!Number.isFinite(radius)) return Infinity;

  const halfViewportPx = cam.viewportHeightPx * 0.5;
  // Fail open on a zero/negative viewport (e.g. mid-resize race): 0 would
  // project EVERY box to 0 px and cull the whole scene.
  if (!(halfViewportPx > 0)) return Infinity;

  if (cam.mode === 'orthographic') {
    if (!(cam.orthoHalfHeight > 0)) return Infinity;
    return (radius / cam.orthoHalfHeight) * halfViewportPx;
  }

  const cx = (min[0] + max[0]) * 0.5 - cam.eye.x;
  const cy = (min[1] + max[1]) * 0.5 - cam.eye.y;
  const cz = (min[2] + max[2]) * 0.5 - cam.eye.z;
  // View depth: what the perspective divide actually uses. A degenerate
  // (non-normalized garbage / zero) viewDir must fail open, not cull.
  const dirLenSq =
    cam.viewDir.x * cam.viewDir.x + cam.viewDir.y * cam.viewDir.y + cam.viewDir.z * cam.viewDir.z;
  if (!(dirLenSq > 0.5) || !Number.isFinite(dirLenSq)) return Infinity;
  const depth = cx * cam.viewDir.x + cy * cam.viewDir.y + cz * cam.viewDir.z;
  // Sphere reaches (or is behind) the camera plane: never cull.
  if (depth <= radius) return Infinity;

  const tanHalfFov = Math.tan(cam.fovYRadians * 0.5);
  if (!(tanHalfFov > 0)) return Infinity;
  return (radius / (depth * tanHalfFov)) * halfViewportPx;
}
