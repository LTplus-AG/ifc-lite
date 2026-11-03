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
 * - Perspective (reverse-Z, infinite far): NDC depth is `near / d`. Scaling it
 *   by `1 + k` divides the distance by `1 + k`. The nudge used to do that in
 *   the vertex stage with `k = hash * 1e-6`, moving a surface up to
 *   `2.55e-4 * d`: under 3 mm at 10 m, but 15 mm at 60 m and 25 mm at 100 m,
 *   which drew a wall over cladding panels a centimetre in front of it once
 *   zoomed out (#7955).
 *
 *   It is now applied in the fragment stage (`nudgedFragDepth`, written to
 *   `frag_depth`), from each MSAA sample's own view depth `w = near / z`:
 *   `k = hash * min(1e-6, PERSPECTIVE_MAX_DEPTH_NUDGE_METRES / (255 * w))`.
 *   Closer than `bound / 2.55e-4` (about 8 m) that is the old nudge, unchanged.
 *   Further out no pixel moves more than `hash / 255 * bound`, whatever the
 *   camera's target or the triangle's size. A vertex-stage bound could not
 *   promise that: the rasterizer interpolates clip z across a triangle in 3D,
 *   so a triangle reaching from near the camera into the distance carried
 *   its near vertex's large factor into its far interior, and the reverse.
 *   Coplanar ranking past the knee: hashes `delta` apart are
 *   `delta / 255 * bound` apart in depth, so close hashes fall to draw order
 *   once that is under the depth noise; the measured distances are pinned in
 *   `tests/e2e/perspective-distance-depth.e2e.spec.ts`.
 *
 *   Writing `frag_depth` costs early depth rejection. One `frag_depth` per
 *   pixel would give every MSAA sample the pixel centre's depth, so creases
 *   (mullions, slab edges) would be decided per pixel and alias into stair
 *   steps. The depth is therefore read from a sample-interpolated varying
 *   (`VertexOutput.sampleDepth`), which runs the fragment stage once per
 *   sample: each sample writes its own depth, as without `frag_depth`.
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

/** Perspective: relative distance shift per hash step, near the camera. */
export const PERSPECTIVE_DEPTH_NUDGE_PER_STEP = 1e-6;

/** Perspective: the furthest the largest hash moves any pixel toward the camera, in metres. */
export const PERSPECTIVE_MAX_DEPTH_NUDGE_METRES = 0.002;

/** Orthographic: NDC depth between adjacent hash levels, eight units of a 24-bit depth buffer. */
export const ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL = 8 * 2 ** -24;

/** Orthographic: the furthest any surface moves toward the camera, in metres. */
export const ORTHOGRAPHIC_MAX_DEPTH_NUDGE_METRES = 0.025;

/** Largest mesh hash (`zHash` is masked to 8 bits). */
export const MAX_DEPTH_NUDGE_HASH = 255;

/** Perspective: NDC lift for annotation lines and text; also the orthographic minimum. */
export const PERSPECTIVE_OVERLAY_DEPTH_LIFT = 5e-5;

/** Keep explanations above, outside the shipped WGSL literals (#7918). */
const projectionWgsl = `
        const ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL: f32 = ${ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL};
        const ORTHOGRAPHIC_MAX_DEPTH_NUDGE_METRES: f32 = ${ORTHOGRAPHIC_MAX_DEPTH_NUDGE_METRES};
        const MAX_DEPTH_NUDGE_HASH: f32 = ${MAX_DEPTH_NUDGE_HASH}.0;

        fn isOrthographicProjection(viewProj: mat4x4<f32>) -> bool {
          return viewProj[0][3] == 0.0 && viewProj[1][3] == 0.0 && viewProj[2][3] == 0.0 && viewProj[3][3] == 1.0;
        }

        fn orthographicNudgeLevels(viewProj: mat4x4<f32>) -> u32 {
          let depthRange = 1.0 / length(vec3<f32>(viewProj[0][2], viewProj[1][2], viewProj[2][2]));
          let steps = ORTHOGRAPHIC_MAX_DEPTH_NUDGE_METRES / (depthRange * ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL);
          return u32(clamp(floor(steps), 0.0, MAX_DEPTH_NUDGE_HASH)) + 1u;
        }

        fn orthographicOffsetInsideDepthRange(clip: vec4<f32>, ndcOffset: f32) -> f32 {
          if (!(clip.z > 0.0 && clip.z < clip.w)) { return clip.z; }
          return min(clip.z + ndcOffset * clip.w, clip.w);
        }
`;

export const depthNudgeWgsl = `
        ${projectionWgsl}
        const PERSPECTIVE_DEPTH_NUDGE_PER_STEP: f32 = ${PERSPECTIVE_DEPTH_NUDGE_PER_STEP};
        const PERSPECTIVE_MAX_DEPTH_NUDGE_METRES: f32 = ${PERSPECTIVE_MAX_DEPTH_NUDGE_METRES};

        // Vertex stage: orthographic only; perspective nudges per fragment.
        fn nudgedClipZ(clip: vec4<f32>, zHash: u32, viewProj: mat4x4<f32>) -> f32 {
          if (isOrthographicProjection(viewProj)) {
            let level = (zHash * orthographicNudgeLevels(viewProj)) >> 8u;
            return orthographicOffsetInsideDepthRange(clip, f32(level) * ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL);
          }
          return clip.z;
        }

        // Fragment stage, for frag_depth. depth is the sample's rasterized
        // depth (VertexOutput.sampleDepth). Perspective: viewProj[3][2] is
        // near, and the view depth is near / depth.
        fn nudgedFragDepth(depth: f32, zHash: u32, viewProj: mat4x4<f32>) -> f32 {
          if (isOrthographicProjection(viewProj)) { return depth; }
          let near = max(viewProj[3][2], 1e-30);
          let step = min(PERSPECTIVE_DEPTH_NUDGE_PER_STEP, PERSPECTIVE_MAX_DEPTH_NUDGE_METRES * depth / (MAX_DEPTH_NUDGE_HASH * near));
          return depth * (1.0 + f32(zHash) * step);
        }
`;

/**
 * The mesh shader's depth plumbing (main.wgsl.ts, which supplies
 * `VertexOutput` and `uniforms`). Every vertex entry writes the unbiased
 * depth (the orthographic visibility prepass), applies the vertex nudge and
 * emits the result as `sampleDepth`, a sample-interpolated varying. Reading it
 * runs the fragment stage once per MSAA sample, so `meshFragDepth` gives each
 * sample its own nudged depth and creases resolve per sample, as they do
 * without `frag_depth`. Every pass that depth-tests against the scene writes
 * `meshFragDepth`.
 */
export const meshDepthWgsl = `
        fn writeMeshDepth(output: ptr<function, VertexOutput>, zHash: u32) {
          (*output).geometricDepth = (*output).position.z / (*output).position.w;
          (*output).position.z = nudgedClipZ((*output).position, zHash, uniforms.viewProj);
          (*output).sampleDepth = (*output).position.z / (*output).position.w;
          (*output).zHash = zHash;
        }

        fn meshFragDepth(input: VertexOutput) -> f32 {
          return nudgedFragDepth(input.sampleDepth, input.zHash, uniforms.viewProj);
        }
`;

export const overlayDepthLiftWgsl = `
        ${projectionWgsl}
        const PERSPECTIVE_OVERLAY_DEPTH_LIFT: f32 = ${PERSPECTIVE_OVERLAY_DEPTH_LIFT};

        fn overlayLiftedClipZ(clip: vec4<f32>, viewProj: mat4x4<f32>) -> f32 {
          if (isOrthographicProjection(viewProj)) {
            let levelsLift = f32(orthographicNudgeLevels(viewProj) + 1u) * ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL;
            return orthographicOffsetInsideDepthRange(clip, max(PERSPECTIVE_OVERLAY_DEPTH_LIFT, levelsLift));
          }
          return clip.z + PERSPECTIVE_OVERLAY_DEPTH_LIFT * clip.w;
        }
`;
