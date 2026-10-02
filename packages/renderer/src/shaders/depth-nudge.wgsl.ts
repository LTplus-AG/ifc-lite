/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two reverse-Z depth offsets that order coincident surfaces, and the one
 * place that sizes them per projection.
 *
 * Mesh nudge (`depthNudgeWgsl`). Every vertex entry of the main shader
 * (`vs_main`, `vs_main_quantized`, `vs_instanced`), and so every pass that
 * reuses them (the selection highlight, the `'equal'` overlay, the selection
 * mask), moves a fragment toward the camera by a deterministic hash step
 * (0-255, from the entity lane: see `main.wgsl.ts`), so coplanar faces of
 * different entities resolve the same way every frame. A pass that drew the
 * same mesh with a different nudge would no longer match the depth its batch
 * wrote.
 *
 * Overlay lift (`overlayDepthLiftWgsl`). Annotation lines and text that lie
 * on a model face (#812) are raised above it by a constant NDC offset. It has
 * to beat the largest mesh nudge, or a label disappears under any surface
 * whose hash happens to be high.
 *
 * The two projections map distance to depth differently:
 *
 * - Perspective (reverse-Z, infinite far): clip z is the constant `near` and
 *   NDC depth is `near / d`. Scaling clip z by `1 + k` is the same as dividing
 *   the distance by `1 + k`, so the mesh nudge is relative to the fragment's
 *   distance: under 3 mm at 10 m for the largest hash.
 * - Orthographic: NDC depth is linear over the whole scene bounding range
 *   (`computeOrthoNearFar`). Scaling clip z by `1 + k` would shift a fragment
 *   by `k * z * range`. On a 1.5 km range that is about 20 cm mid-scene and
 *   nearly 40 cm near the camera, far more than the gap between a rod and the
 *   face of the beam it passes through, so hidden surfaces were drawn in front
 *   of visible ones (#6729). It also faded to nothing toward the far plane,
 *   where z goes to 0, so coplanar faces there were not separated at all.
 *   Here each step is instead a fixed number of 24-bit depth-buffer units, the
 *   same at every depth. Too few units and two triangulations of one plane,
 *   whose interpolated depths disagree by about a unit, still z-fight:
 *   overlapping coplanar plates did at one, two and three units per step but
 *   not at four. The largest hash then shifts a fragment by `255 * 4 / 2^24`
 *   of the range, about 9 cm at 1.5 km and under 1 cm for a 100 m building.
 *   That is more than the perspective overlay lift, so the orthographic lift
 *   sits just above it instead.
 */

/** Perspective: relative distance shift per hash step. */
export const PERSPECTIVE_DEPTH_NUDGE_PER_STEP = 1e-6;

/** Orthographic: NDC depth shift per hash step, four units of a 24-bit depth buffer. */
export const ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP = 4 * 2 ** -24;

/** Largest mesh hash step (`zHash` is masked to 8 bits). */
export const MAX_DEPTH_NUDGE_STEPS = 255;

/** Perspective: NDC lift for annotation lines and text. */
export const PERSPECTIVE_OVERLAY_DEPTH_LIFT = 5e-5;

/**
 * Orthographic: NDC lift for annotation lines and text, two steps above the
 * largest mesh nudge. The margin also covers the text pipeline's constant
 * `depthBias: -4`, which pushes glyphs four units back.
 */
export const ORTHOGRAPHIC_OVERLAY_DEPTH_LIFT = (MAX_DEPTH_NUDGE_STEPS + 2) * ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP;

const projectionWgsl = `
        // An orthographic view-projection leaves w at 1: its bottom row is exactly
        // (0, 0, 0, 1), because the projection's and the view's bottom rows are
        // both (0, 0, 0, 1). A perspective one copies the forward axis into that
        // row, a unit vector, so it is never zero. Every caller passes the
        // camera's world view-projection, which each draw packs whether or not
        // it renders camera-relative.
        fn isOrthographicProjection(viewProj: mat4x4<f32>) -> bool {
          return viewProj[0][3] == 0.0 && viewProj[1][3] == 0.0 && viewProj[2][3] == 0.0 && viewProj[3][3] == 1.0;
        }
`;

export const depthNudgeWgsl = `
        ${projectionWgsl}
        const PERSPECTIVE_DEPTH_NUDGE_PER_STEP: f32 = ${PERSPECTIVE_DEPTH_NUDGE_PER_STEP};
        const ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP: f32 = ${ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP};

        // Clip-space z with the entity's depth nudge applied (depth-nudge.wgsl.ts).
        fn nudgedClipZ(clip: vec4<f32>, zHash: u32, viewProj: mat4x4<f32>) -> f32 {
          if (isOrthographicProjection(viewProj)) {
            return clip.z + f32(zHash) * ORTHOGRAPHIC_DEPTH_NUDGE_PER_STEP * clip.w;
          }
          return clip.z * (1.0 + f32(zHash) * PERSPECTIVE_DEPTH_NUDGE_PER_STEP);
        }
`;

export const overlayDepthLiftWgsl = `
        ${projectionWgsl}
        const PERSPECTIVE_OVERLAY_DEPTH_LIFT: f32 = ${PERSPECTIVE_OVERLAY_DEPTH_LIFT};
        const ORTHOGRAPHIC_OVERLAY_DEPTH_LIFT: f32 = ${ORTHOGRAPHIC_OVERLAY_DEPTH_LIFT};

        // Clip-space z raised above any nudged mesh face (depth-nudge.wgsl.ts).
        // A multiple of clip.w is a constant NDC offset after the w-divide, which
        // under reverse-Z reads as "slightly closer".
        fn overlayLiftedClipZ(clip: vec4<f32>, viewProj: mat4x4<f32>) -> f32 {
          let lift = select(PERSPECTIVE_OVERLAY_DEPTH_LIFT, ORTHOGRAPHIC_OVERLAY_DEPTH_LIFT, isOrthographicProjection(viewProj));
          return clip.z + lift * clip.w;
        }
`;
