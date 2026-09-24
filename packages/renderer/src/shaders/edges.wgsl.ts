/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Edge pass (#5385): a single fullscreen pass that darkens along entity-id
 * changes, normal creases, and depth silhouettes, replacing the separation-
 * line pass in `post-processor.ts`.
 *
 * View-space position and normal come from `depth-reconstruct.wgsl.ts`
 * (shared with the ambient-occlusion pass, #5384: one reconstruction, not
 * two). The entity-id attachment is decoded the same way the old
 * separation-line pass did (`encodeId24`/`decodeId24` in `main.wgsl.ts`).
 *
 * Each of `directions` tap offsets (4 cardinal at `low`, +4 diagonal at
 * `high`) votes 0/1 on three cues — id change, normal crease, depth
 * silhouette — and the pass darkens by the AVERAGE vote across directions.
 * That average is a coverage estimate, not a single hard sample, so a line
 * that only grazes one direction fades instead of dashing on/off between
 * frames of the same seam (the bug this pass replaces, `post-processor.ts`
 * introduced its own version of this coverage trick for the id test alone;
 * this generalises it to all three cues and both new tests).
 */
import { EDGE_CREASE_COS, EDGE_MAX_DARKEN, EDGE_SILHOUETTE_REL_THRESHOLD } from '../edge-params.js';
import { SELECTION_HIDDEN_ALPHA } from '../outline-params.js';
import { depthReconstructWgsl, depthTextureWgsl } from './depth-reconstruct.wgsl.js';

export function edgeShaderSource(multisampled: boolean): string {
  // Multisampled and non-multisampled `textureLoad` share this call shape:
  // the third argument is the sample index (MS) or the mip level (non-MS),
  // both 0, so one call site covers both declarations (`post-processor.ts`
  // used the same trick).
  const idTexDecl = multisampled
    ? '@group(0) @binding(1) var idTex: texture_multisampled_2d<f32>;'
    : '@group(0) @binding(1) var idTex: texture_2d<f32>;';

  return `
        struct EdgeParams {
          depthParams: vec4<f32>,  // m10, m11, m14, m15
          xyParams: vec4<f32>,     // m0, m5, m12, m13
          viewport: vec4<f32>,     // full-res width, height, 1/width, 1/height
          edge: vec4<f32>,         // tap radius px, intensity, highQuality (0/1), _pad
        }

        ${depthTextureWgsl(0, multisampled)}
        ${idTexDecl}
        @group(0) @binding(2) var<uniform> params: EdgeParams;

        ${depthReconstructWgsl}

        const EDGE_CREASE_COS: f32 = ${EDGE_CREASE_COS.toFixed(6)};
        const EDGE_SILHOUETTE_REL: f32 = ${EDGE_SILHOUETTE_REL_THRESHOLD.toFixed(6)};
        const EDGE_MAX_DARKEN: f32 = ${EDGE_MAX_DARKEN.toFixed(3)};

        struct VsOut {
          @builtin(position) pos: vec4<f32>,
        }

        @vertex
        fn vs_fullscreen(@builtin(vertex_index) v: u32) -> VsOut {
          var p = array<vec2<f32>, 3>(
            vec2<f32>(-1.0, -3.0),
            vec2<f32>(-1.0,  1.0),
            vec2<f32>( 3.0,  1.0)
          );
          var o: VsOut;
          o.pos = vec4<f32>(p[v], 0.0, 1.0);
          return o;
        }

        fn decodeId24(encoded: vec4<f32>) -> u32 {
          let r = u32(round(encoded.r * 255.0)) & 255u;
          let g = u32(round(encoded.g * 255.0)) & 255u;
          let b = u32(round(encoded.b * 255.0)) & 255u;
          return (r << 16u) | (g << 8u) | b;
        }

        fn loadId(ip: vec2<i32>, dims: vec2<i32>) -> u32 {
          let c = clamp(ip, vec2<i32>(0), dims - 1);
          return decodeId24(textureLoad(idTex, c, 0));
        }

        fn viewPosAt(ip: vec2<i32>, d: f32) -> vec3<f32> {
          return viewPositionFromDepth(ndcFromPixel(ip, params.viewport.zw), d, params.depthParams, params.xyParams);
        }

        // One tap direction's edge vote in [0, 1]: 1 if the id changes, the
        // local normal creases past the angle threshold, or the view-space
        // depth steps past the silhouette threshold.
        fn tapVote(p: vec2<i32>, q: vec2<i32>, dims: vec2<i32>, centerId: u32, centerP: vec3<f32>, centerN: vec3<f32>) -> f32 {
          let qc = clamp(q, vec2<i32>(0), dims - 1);
          let dq = loadDepth(qc);
          if (dq <= BACKGROUND_DEPTH) {
            return 0.0;
          }
          let neighbourId = loadId(qc, dims);
          let idVote = f32(neighbourId != centerId && neighbourId != 0u && centerId != 0u);

          let Pq = viewPosAt(qc, dq);
          let depthRef = max(-centerP.z, 1e-4);
          let silhouetteVote = f32(abs(Pq.z - centerP.z) / depthRef > EDGE_SILHOUETTE_REL);

          // Neighbour normal from ITS OWN neighbours (not just the two
          // points), so a grazing coplanar surface (large positional slope,
          // near-zero normal change) does not misread as a crease.
          let dLeft = loadDepth(clamp(qc + vec2<i32>(-1, 0), vec2<i32>(0), dims - 1));
          let dRight = loadDepth(clamp(qc + vec2<i32>(1, 0), vec2<i32>(0), dims - 1));
          let dUp = loadDepth(clamp(qc + vec2<i32>(0, -1), vec2<i32>(0), dims - 1));
          let dDown = loadDepth(clamp(qc + vec2<i32>(0, 1), vec2<i32>(0), dims - 1));
          let Nq = normalFromNeighbours(
            Pq,
            select(centerP, viewPosAt(qc + vec2<i32>(1, 0), dRight), dRight > BACKGROUND_DEPTH),
            select(centerP, viewPosAt(qc + vec2<i32>(-1, 0), dLeft), dLeft > BACKGROUND_DEPTH),
            select(centerP, viewPosAt(qc + vec2<i32>(0, 1), dDown), dDown > BACKGROUND_DEPTH),
            select(centerP, viewPosAt(qc + vec2<i32>(0, -1), dUp), dUp > BACKGROUND_DEPTH),
          );
          let creaseVote = f32(dot(centerN, Nq) < EDGE_CREASE_COS);

          return max(idVote, max(creaseVote, silhouetteVote));
        }

        @fragment
        fn fs_edges(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
          let dims = vec2<i32>(params.viewport.xy);
          let p = vec2<i32>(fragPos.xy);
          let d = loadDepth(p);
          if (d <= BACKGROUND_DEPTH) {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0);
          }
          let centerId = loadId(p, dims);
          let centerP = viewPosAt(p, d);
          let centerN = normalFromNeighbours(
            centerP,
            viewPosAt(clamp(p + vec2<i32>(1, 0), vec2<i32>(0), dims - 1), loadDepth(p + vec2<i32>(1, 0))),
            viewPosAt(clamp(p - vec2<i32>(1, 0), vec2<i32>(0), dims - 1), loadDepth(p - vec2<i32>(1, 0))),
            viewPosAt(clamp(p + vec2<i32>(0, 1), vec2<i32>(0), dims - 1), loadDepth(p + vec2<i32>(0, 1))),
            viewPosAt(clamp(p - vec2<i32>(0, 1), vec2<i32>(0), dims - 1), loadDepth(p - vec2<i32>(0, 1))),
          );

          let r = i32(round(params.edge.x));
          var votes = 0.0;
          votes = votes + tapVote(p, p + vec2<i32>( r,  0), dims, centerId, centerP, centerN);
          votes = votes + tapVote(p, p + vec2<i32>(-r,  0), dims, centerId, centerP, centerN);
          votes = votes + tapVote(p, p + vec2<i32>( 0,  r), dims, centerId, centerP, centerN);
          votes = votes + tapVote(p, p + vec2<i32>( 0, -r), dims, centerId, centerP, centerN);
          var directions = 4.0;

          if (params.edge.z > 0.5) {
            votes = votes + tapVote(p, p + vec2<i32>( r,  r), dims, centerId, centerP, centerN);
            votes = votes + tapVote(p, p + vec2<i32>(-r,  r), dims, centerId, centerP, centerN);
            votes = votes + tapVote(p, p + vec2<i32>( r, -r), dims, centerId, centerP, centerN);
            votes = votes + tapVote(p, p + vec2<i32>(-r, -r), dims, centerId, centerP, centerN);
            directions = 8.0;
          }

          let coverage = votes / directions;
          let darken = clamp(coverage * params.edge.y, 0.0, EDGE_MAX_DARKEN);
          return vec4<f32>(0.0, 0.0, 0.0, darken);
        }
`;
}

/**
 * Selection/hover outline composite (#5390): outlines the mask the
 * selection-mask pass wrote (`selection-mask-pass.ts`), sharing this
 * module's fullscreen-triangle vertex stage with the geometry edge pass
 * above (DRY, per the #5385/#5390 design note) even though the two run as
 * separate draws with different blend states (this one is a normal
 * alpha-over composite; the geometry pass above is darken-only).
 *
 * Coverage at each of 4 neighbour taps, same idea as `fs_edges`'s id test:
 * `abs(neighbour - center)` summed and averaged is 1 exactly on the mask's
 * boundary and fades over the tap radius, so the line antialiases instead
 * of being a hard 1px stairstep. No depth/normal reconstruction needed —
 * unlike geometry edges, a mask boundary is unambiguous on its own.
 */
export function outlineFragmentSource(): string {
  return `
        struct OutlineParams {
          viewport: vec4<f32>,       // width, height, unused, unused
          selectionColor: vec4<f32>, // rgb, visible alpha
          hoverColor: vec4<f32>,     // rgb, visible alpha
        }

        @group(0) @binding(0) var maskVisible: texture_2d<f32>;
        @group(0) @binding(1) var maskAll: texture_2d<f32>;
        @group(0) @binding(2) var<uniform> params: OutlineParams;

        const SELECTION_HIDDEN_ALPHA: f32 = ${SELECTION_HIDDEN_ALPHA.toFixed(3)};

        struct VsOut {
          @builtin(position) pos: vec4<f32>,
        }

        @vertex
        fn vs_fullscreen(@builtin(vertex_index) v: u32) -> VsOut {
          var p = array<vec2<f32>, 3>(
            vec2<f32>(-1.0, -3.0),
            vec2<f32>(-1.0,  1.0),
            vec2<f32>( 3.0,  1.0)
          );
          var o: VsOut;
          o.pos = vec4<f32>(p[v], 0.0, 1.0);
          return o;
        }

        fn loadClamped(tex: texture_2d<f32>, ip: vec2<i32>, dims: vec2<i32>) -> vec4<f32> {
          return textureLoad(tex, clamp(ip, vec2<i32>(0), dims - 1), 0);
        }

        // Fraction of the 4 cardinal neighbours whose channel differs from
        // the centre: 0 inside/outside the region, ~1 exactly astride its
        // boundary — a coverage estimate, not a hard edge test.
        fn boundaryCoverage(tex: texture_2d<f32>, channel: u32, p: vec2<i32>, dims: vec2<i32>) -> f32 {
          let center = loadClamped(tex, p, dims)[channel];
          let n1 = loadClamped(tex, p + vec2<i32>(1, 0), dims)[channel];
          let n2 = loadClamped(tex, p + vec2<i32>(-1, 0), dims)[channel];
          let n3 = loadClamped(tex, p + vec2<i32>(0, 1), dims)[channel];
          let n4 = loadClamped(tex, p + vec2<i32>(0, -1), dims)[channel];
          return (abs(n1 - center) + abs(n2 - center) + abs(n3 - center) + abs(n4 - center)) * 0.25;
        }

        @fragment
        fn fs_outline(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
          let dims = vec2<i32>(params.viewport.xy);
          let p = vec2<i32>(fragPos.xy);

          let visibleCoverage = boundaryCoverage(maskVisible, 0u, p, dims);
          let allCoverage = boundaryCoverage(maskAll, 0u, p, dims);
          let hoverCoverage = boundaryCoverage(maskVisible, 1u, p, dims);

          // The "hidden" ring is the silhouette of the unoccluded shape
          // (maskAll) wherever this pixel is not itself part of the visible
          // selection — so it does not double up with the solid ring.
          let centerVisible = loadClamped(maskVisible, p, dims).r;
          let hiddenCoverage = allCoverage * (1.0 - centerVisible);

          let selectionAlpha = clamp(
            max(visibleCoverage * params.selectionColor.a, hiddenCoverage * SELECTION_HIDDEN_ALPHA),
            0.0, 1.0,
          );
          if (selectionAlpha > 0.001) {
            return vec4<f32>(params.selectionColor.rgb * selectionAlpha, selectionAlpha);
          }

          let hoverAlpha = clamp(hoverCoverage * params.hoverColor.a, 0.0, 1.0);
          return vec4<f32>(params.hoverColor.rgb * hoverAlpha, hoverAlpha);
        }
`;
}
