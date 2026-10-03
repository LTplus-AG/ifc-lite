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
 * mask), moves a fragment toward the camera by a deterministic per-entity hash
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
 *   NDC depth is `near / d`. Scaling clip z by `1 + k` divides the distance by
 *   `1 + k`, so the nudge is relative to the fragment's distance: under 3 mm
 *   at 10 m for the largest hash. Unchanged by #6729.
 * - Orthographic: NDC depth is linear over the scene's bounding range
 *   (`computeOrthoNearFar`). Scaling clip z would shift a fragment by
 *   `k * z * range`: on a 1.5 km range about 20 cm mid-scene and nearly 40 cm
 *   near the camera, enough to draw a rod in front of the beam it runs through
 *   (#6729). So the orthographic nudge is a physical bound instead: no surface
 *   moves more than `ORTHOGRAPHIC_MAX_DEPTH_NUDGE_METRES` toward the camera.
 *
 *   The hash is ranked into levels one `ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL`
 *   apart. A level has to exceed the depth noise between two triangulations of
 *   one plane, or coplanar faces still z-fight, and that noise grows with how
 *   obliquely the face is seen. On the tested SwiftShader backend, steep views
 *   of overlapping coplanar plates z-fought at one to three 24-bit units per
 *   level; eight units, about what the old nudge gave mid-scene, keeps oblique
 *   and grazing views of ordinary sites as good as before. Within the metre
 *   bound that leaves `bound / (range * level)` levels: all 256 up to about a
 *   205 m depth range, about 52 at 1 km. Past that, coplanar entities a level
 *   or two apart can swap at grazing angles, and two on one level are left to
 *   draw order. That is the price of keeping hidden surfaces hidden: the old
 *   nudge ranked them only because it moved every surface by decimetres.
 *
 *   The range comes from the view-projection itself: its z row is the view's
 *   unit backward axis scaled by `1 / (far - near)`. Every draw of one frame
 *   sees the same matrix, so they all rank alike. The range is the bounding
 *   sphere's, so it does not change as the camera orbits.
 *
 *   The nudge, and the orthographic overlay lift, only move a vertex that is
 *   strictly inside the depth range, and never past the near plane. A vertex beyond either plane, or exactly on the
 *   far plane (which the reverse-Z clear to 0 and `'greater'` never write), is
 *   left where it is, so nothing changes which side of a clip plane it is on.
 */

/** Perspective: relative distance shift per hash step. */
export const PERSPECTIVE_DEPTH_NUDGE_PER_STEP = 1e-6;

/** Orthographic: NDC depth between adjacent hash levels, eight units of a 24-bit depth buffer. */
export const ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL = 8 * 2 ** -24;

/** Orthographic: the furthest any surface moves toward the camera, in metres. */
export const ORTHOGRAPHIC_MAX_DEPTH_NUDGE_METRES = 0.025;

/** Largest mesh hash (`zHash` is masked to 8 bits). */
export const MAX_DEPTH_NUDGE_HASH = 255;

/** Perspective: NDC lift for annotation lines and text; also the orthographic minimum. */
export const PERSPECTIVE_OVERLAY_DEPTH_LIFT = 5e-5;

const projectionWgsl = `
        const ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL: f32 = ${ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL};
        const ORTHOGRAPHIC_MAX_DEPTH_NUDGE_METRES: f32 = ${ORTHOGRAPHIC_MAX_DEPTH_NUDGE_METRES};
        const MAX_DEPTH_NUDGE_HASH: f32 = ${MAX_DEPTH_NUDGE_HASH}.0;

        // An orthographic view-projection leaves w at 1: its bottom row is exactly
        // (0, 0, 0, 1), because the projection's and the view's bottom rows are
        // both (0, 0, 0, 1). A perspective one copies the forward axis into that
        // row, a unit vector, so it is never zero. Every caller passes the
        // camera's world view-projection, which each draw packs whether or not
        // it renders camera-relative.
        fn isOrthographicProjection(viewProj: mat4x4<f32>) -> bool {
          return viewProj[0][3] == 0.0 && viewProj[1][3] == 0.0 && viewProj[2][3] == 0.0 && viewProj[3][3] == 1.0;
        }

        // Orthographic only: how many hash levels fit the metre bound. The z row
        // of the view-projection has length 1 / (far - near).
        fn orthographicNudgeLevels(viewProj: mat4x4<f32>) -> u32 {
          let depthRange = 1.0 / length(vec3<f32>(viewProj[0][2], viewProj[1][2], viewProj[2][2]));
          let steps = ORTHOGRAPHIC_MAX_DEPTH_NUDGE_METRES / (depthRange * ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL);
          return u32(clamp(floor(steps), 0.0, MAX_DEPTH_NUDGE_HASH)) + 1u;
        }

        // Orthographic only: clip z moved \`ndcOffset\` toward the camera without
        // changing which side of a clip plane the vertex is on. A vertex beyond
        // either plane, or exactly on the far plane, stays where it is.
        fn orthographicOffsetInsideDepthRange(clip: vec4<f32>, ndcOffset: f32) -> f32 {
          if (!(clip.z > 0.0 && clip.z < clip.w)) { return clip.z; }
          return min(clip.z + ndcOffset * clip.w, clip.w);
        }
`;

export const depthNudgeWgsl = `
        ${projectionWgsl}
        const PERSPECTIVE_DEPTH_NUDGE_PER_STEP: f32 = ${PERSPECTIVE_DEPTH_NUDGE_PER_STEP};

        // Clip-space z with the entity's depth nudge applied (depth-nudge.wgsl.ts).
        fn nudgedClipZ(clip: vec4<f32>, zHash: u32, viewProj: mat4x4<f32>) -> f32 {
          if (isOrthographicProjection(viewProj)) {
            let level = (zHash * orthographicNudgeLevels(viewProj)) >> 8u;
            return orthographicOffsetInsideDepthRange(clip, f32(level) * ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL);
          }
          return clip.z * (1.0 + f32(zHash) * PERSPECTIVE_DEPTH_NUDGE_PER_STEP);
        }
`;

export const overlayDepthLiftWgsl = `
        ${projectionWgsl}
        const PERSPECTIVE_OVERLAY_DEPTH_LIFT: f32 = ${PERSPECTIVE_OVERLAY_DEPTH_LIFT};

        // Clip-space z raised above any nudged mesh face (depth-nudge.wgsl.ts).
        // A multiple of clip.w is a constant NDC offset after the w-divide, which
        // under reverse-Z reads as "slightly closer". Orthographic keeps at least
        // the perspective lift, and two levels above the highest nudge level
        // when that is more (all 256 levels in use), so the text pipeline's
        // constant depthBias of -4 units is covered too.
        fn overlayLiftedClipZ(clip: vec4<f32>, viewProj: mat4x4<f32>) -> f32 {
          if (isOrthographicProjection(viewProj)) {
            let levelsLift = f32(orthographicNudgeLevels(viewProj) + 1u) * ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL;
            return orthographicOffsetInsideDepthRange(clip, max(PERSPECTIVE_OVERLAY_DEPTH_LIFT, levelsLift));
          }
          return clip.z + PERSPECTIVE_OVERLAY_DEPTH_LIFT * clip.w;
        }
`;
