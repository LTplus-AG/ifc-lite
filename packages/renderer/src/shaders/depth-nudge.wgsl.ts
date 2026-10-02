/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-entity anti z-fighting depth nudge, shared by every vertex entry of the
 * main shader (`vs_main`, `vs_main_quantized`, `vs_instanced`) and therefore
 * by every pass that reuses them (the selection highlight, the `'equal'`
 * overlay, the selection mask). A pass that drew the same mesh with a
 * different nudge would no longer match the depth its batch wrote.
 *
 * Each step moves a fragment toward the camera by one deterministic hash step
 * (0-255, from the entity lane: see `main.wgsl.ts`), so coplanar faces of
 * different entities resolve the same way every frame.
 *
 * The step has to be sized per projection, because the two map distance to
 * depth differently:
 *
 * - Perspective (reverse-Z, infinite far): clip z is the constant `near` and
 *   NDC depth is `near / d`. Scaling clip z by `1 + k` is the same as dividing
 *   the distance by `1 + k`, so the shift is relative to the fragment's
 *   distance: under 3 mm at 10 m for the largest hash.
 * - Orthographic: NDC depth is linear over the whole scene bounding range
 *   (`computeOrthoNearFar`). Scaling clip z by `1 + k` would shift a fragment
 *   by `k * z * range`, up to about 20 cm on a kilometre-scale site. That is
 *   far more than the gap between a rod and the face of the beam it passes
 *   through, so hidden surfaces were drawn in front of visible ones (#6729).
 *   It also faded to nothing toward the far plane, where z goes to 0, so
 *   coplanar faces there were not separated at all.
 *   Here each step is instead a fixed number of 24-bit depth-buffer units, the
 *   same at every depth. One unit is too few: two triangulations of one plane
 *   interpolate depths that disagree by about a unit, and overlapping coplanar
 *   plates z-fought at one and two units per step but not at four. The largest
 *   hash then shifts a fragment by `255 * 4 / 2^24` of the range, about 9 cm at
 *   1.5 km and under 1 cm for a 100 m building.
 */

/** Perspective: relative distance shift per hash step. */
export const PERSPECTIVE_DEPTH_NUDGE_PER_STEP = 1e-6;

/** Orthographic: NDC depth shift per hash step, four units of a 24-bit depth buffer. */
export const ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP = 4 * 2 ** -24;

export const depthNudgeWgsl = `
        const PERSPECTIVE_DEPTH_NUDGE_PER_STEP: f32 = ${PERSPECTIVE_DEPTH_NUDGE_PER_STEP};
        const ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP: f32 = ${ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP};

        // An orthographic view-projection leaves w at 1: its bottom row is exactly
        // (0, 0, 0, 1), because the projection's and the view's bottom rows are
        // both (0, 0, 0, 1). A perspective one copies -forward into that row, a
        // unit vector, so it is never zero. uniforms.viewProj is packed for every
        // draw, RTE or not, from the same camera frame as rteViewProj.
        fn isOrthographicProjection(viewProj: mat4x4<f32>) -> bool {
          return viewProj[0][3] == 0.0 && viewProj[1][3] == 0.0 && viewProj[2][3] == 0.0 && viewProj[3][3] == 1.0;
        }

        // Clip-space z with the entity's depth nudge applied (depth-nudge.wgsl.ts).
        fn nudgedClipZ(clip: vec4<f32>, zHash: u32) -> f32 {
          if (isOrthographicProjection(uniforms.viewProj)) {
            return clip.z + f32(zHash) * ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP * clip.w;
          }
          return clip.z * (1.0 + f32(zHash) * PERSPECTIVE_DEPTH_NUDGE_PER_STEP);
        }
`;
