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
 * A sample is ON a line when the tap at `radius` px in ANY of the preset's
 * directions (4 cardinal at `low`, +4 diagonal at `high`) crosses one of the
 * cues: id change, normal crease, depth silhouette, or background (so an
 * object is outlined against the sky; the first version of this pass meant
 * to skip that edge but drew it on some sides through a sign flip in its
 * tap normals). The pass runs that
 * test once per MSAA sample, on the sample grid (sample `s` of a texel
 * against sample `s` of its neighbours), and darkens by the fraction of
 * samples on a line. That fraction is the pixel's coverage of a band of
 * constant width around the geometric edge, so lines are antialiased the
 * way the MSAA geometry under them is.
 *
 * Averaging the 0/1 votes of the directions instead, as this pass first
 * did, is not coverage: on a sloped line the pixel at each stair step has a
 * second direction across the edge, so it drew about twice as dark as its
 * neighbours and a straight crease rendered as a row of ticks, and the
 * single sample per pixel left the line aliased over the antialiased colour.
 *
 * Cost: a pixel fits one plane (normal and device-depth gradient) for its
 * first sample. A tap whose depth lies on that plane is on the same surface,
 * so only a tap off it, near an actual edge, reconstructs its own normal,
 * and the other samples of a texel on the same plane reuse it.
 */
import {
  EDGE_CREASE_COS,
  EDGE_LINE_WEIGHT,
  EDGE_MAX_DARKEN,
  EDGE_SAMPLE_COUNT,
  EDGE_SILHOUETTE_REL_THRESHOLD,
} from '../edge-params.js';
import { OUTLINE_SEARCH_RADIUS, OUTLINE_WIDTH_PX, SELECTION_HIDDEN_ALPHA } from '../outline-params.js';
import { depthReconstructWgsl, depthTextureWgsl } from './depth-reconstruct.wgsl.js';

export function edgeShaderSource(multisampled: boolean): string {
  // Multisampled and non-multisampled `textureLoad` share this call shape:
  // the third argument is the sample index (MS) or the mip level (non-MS),
  // so one call site covers both declarations, with only sample/level 0
  // read on a single-sampled target (`post-processor.ts` used the same trick).
  const idTexDecl = multisampled
    ? '@group(0) @binding(1) var idTex: texture_multisampled_2d<f32>;'
    : '@group(0) @binding(1) var idTex: texture_2d<f32>;';
  const samples = multisampled ? EDGE_SAMPLE_COUNT : 1;

  return `
        struct EdgeParams {
          depthParams: vec4<f32>,  // m10, m11, m14, m15
          xyParams: vec4<f32>,     // m0, m5, m12, m13
          shearParams: vec4<f32>,  // m8, m9, 0, 0 (lens shift, #8688)
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
        const EDGE_LINE_WEIGHT_LOW: f32 = ${EDGE_LINE_WEIGHT.low.toFixed(6)};
        const EDGE_LINE_WEIGHT_HIGH: f32 = ${EDGE_LINE_WEIGHT.high.toFixed(6)};
        const EDGE_SAMPLES: i32 = ${samples};

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

        fn loadId(ip: vec2<i32>, s: i32, dims: vec2<i32>) -> u32 {
          let c = clamp(ip, vec2<i32>(0), dims - 1);
          return decodeId24(textureLoad(idTex, c, s));
        }

        fn viewPosAt(ip: vec2<i32>, d: f32) -> vec3<f32> {
          return viewPositionFromDepth(ndcFromPixel(ip, params.viewport.zw), d, params.depthParams, params.xyParams, params.shearParams);
        }

        // Where each sample sits in its texel: WebGPU's standard 4x
        // positions, or the centre on a single-sampled target.
        const SAMPLE_POS = array<vec2<f32>, ${samples}>(
          ${samples === 1 ? 'vec2<f32>(0.5, 0.5),' : 'vec2<f32>(0.375, 0.125), vec2<f32>(0.875, 0.375), vec2<f32>(0.125, 0.625), vec2<f32>(0.625, 0.875),'}
        );
        const NO_FIT: f32 = 3.0e38;

        // The plane sample \`s\` of a texel lies on: view-space normal (zero
        // when a tangent axis has no neighbour, e.g. a one-pixel sliver), and
        // device depth \`d\` at pixel position \`at\` with its per-pixel gradient.
        // Device depth is affine in screen space across a plane, which is
        // what \`onPlane\` extrapolates.
        struct Plane {
          n: vec3<f32>,
          grad: vec2<f32>,
          d: f32,
          at: vec2<f32>,
        }

        // One tangent axis of the surface at \`ip\` (sample \`s\`, device depth
        // \`d\`, view position \`P\`): xyz the view-space step to a neighbour along
        // \`e\`, w its device-depth step. The side whose next step continues this
        // one (zero second difference: one plane) is on this sample's own
        // surface; the smaller depth change, \`normalFromNeighbours\`' rule,
        // picks the side on a silhouette, but on a crease it can take the
        // other face. Background never counts, nor does a texel outside the
        // viewport (the clamped load would return this texel itself, a
        // zero step that fits perfectly); with neither neighbour the step is
        // zero.
        fn inViewport(ip: vec2<i32>) -> bool {
          return all(ip >= vec2<i32>(0)) && all(ip < vec2<i32>(params.viewport.xy));
        }

        fn axisStep(P: vec3<f32>, d: f32, ip: vec2<i32>, e: vec2<i32>, s: i32) -> vec4<f32> {
          let d1p = loadDepthSample(ip + e, s);
          let d1m = loadDepthSample(ip - e, s);
          let okPlus = inViewport(ip + e) && d1p > BACKGROUND_DEPTH;
          let okMinus = inViewport(ip - e) && d1m > BACKGROUND_DEPTH;
          if (!okPlus && !okMinus) {
            return vec4<f32>(0.0);
          }
          var plus = okPlus;
          if (okPlus && okMinus) {
            let d2p = loadDepthSample(ip + e * 2, s);
            let d2m = loadDepthSample(ip - e * 2, s);
            let errPlus = select(NO_FIT, abs((d2p - d1p) - (d1p - d)), inViewport(ip + e * 2) && d2p > BACKGROUND_DEPTH);
            let errMinus = select(NO_FIT, abs((d1m - d2m) - (d - d1m)), inViewport(ip - e * 2) && d2m > BACKGROUND_DEPTH);
            if (errPlus == errMinus) {
              plus = abs(d1p - d) <= abs(d - d1m);
            } else {
              plus = errPlus < errMinus;
            }
          }
          if (plus) {
            return vec4<f32>(viewPosAt(ip + e, d1p) - P, d1p - d);
          }
          return vec4<f32>(P - viewPosAt(ip - e, d1m), d - d1m);
        }

        fn planeAt(ip: vec2<i32>, s: i32, d: f32) -> Plane {
          let P = viewPosAt(ip, d);
          let tx = axisStep(P, d, ip, vec2<i32>(1, 0), s);
          let ty = axisStep(P, d, ip, vec2<i32>(0, 1), s);
          // Pixel +x is view +x and pixel +y is view -y, so dy x dx faces +z.
          let n = cross(ty.xyz, tx.xyz);
          let len2 = dot(n, n);
          var plane: Plane;
          plane.n = select(vec3<f32>(0.0), n * inverseSqrt(max(len2, 1e-30)), len2 >= 1e-30);
          plane.grad = vec2<f32>(tx.w, ty.w);
          plane.d = d;
          plane.at = vec2<f32>(ip) + SAMPLE_POS[s];
          return plane;
        }

        // Whether sample \`s\` of texel \`ip\`, at device depth \`d\`, lies on
        // \`plane\`: a tolerance of a hundredth of the plane's depth change per
        // pixel, so a point a fraction of a pixel across a crease still
        // counts as off it, plus a few ulps for interpolation roundoff.
        fn onPlane(plane: Plane, ip: vec2<i32>, s: i32, d: f32) -> bool {
          let predicted = plane.d + dot(plane.grad, vec2<f32>(ip) + SAMPLE_POS[s] - plane.at);
          return abs(d - predicted) <= 0.01 * (abs(plane.grad.x) + abs(plane.grad.y)) + 4e-7 * d;
        }

        // Whether the tap at \`q\` (same sample \`s\`) lies across an edge from
        // the centre sample: the tap is background (the outline against the
        // sky), the id changes, the view-space depth steps past the
        // silhouette threshold, or the normal creases past the angle
        // threshold. A tap on the centre's own plane has its normal, so only
        // a tap off it reconstructs one, from ITS OWN neighbours (a grazing
        // coplanar surface, large positional slope and near-zero normal
        // change, does not misread as a crease).
        fn tapCrosses(q: vec2<i32>, s: i32, dims: vec2<i32>, centreId: u32, centreZ: f32, centre: Plane) -> bool {
          let qc = clamp(q, vec2<i32>(0), dims - 1);
          let dq = loadDepthSample(qc, s);
          if (dq <= BACKGROUND_DEPTH) {
            return true;
          }
          let neighbourId = loadId(qc, s, dims);
          if (neighbourId != centreId && neighbourId != 0u && centreId != 0u) {
            return true;
          }
          let zq = viewZFromDepth(dq, params.depthParams);
          if (abs(zq - centreZ) / max(-centreZ, 1e-4) > EDGE_SILHOUETTE_REL) {
            return true;
          }
          if (onPlane(centre, qc, s, dq)) {
            return false;
          }
          // An unknown (zero) normal on either side is no evidence of a crease.
          let nq = planeAt(qc, s, dq).n;
          return dot(centre.n, centre.n) > 0.5 && dot(nq, nq) > 0.5 && dot(centre.n, nq) < EDGE_CREASE_COS;
        }

        const TAPS = array<vec2<i32>, 8>(
          vec2<i32>( 1,  0), vec2<i32>(-1,  0), vec2<i32>( 0,  1), vec2<i32>( 0, -1),
          vec2<i32>( 1,  1), vec2<i32>(-1,  1), vec2<i32>( 1, -1), vec2<i32>(-1, -1),
        );

        // 1.0 when sample \`s\` of texel \`p\`, on plane \`centre\`, is on a
        // line: ANY tap direction crosses an edge (the maximum, not the mean,
        // of the directions).
        fn sampleOnEdge(p: vec2<i32>, s: i32, dims: vec2<i32>, r: i32, count: i32, d: f32, centre: Plane) -> f32 {
          let centreId = loadId(p, s, dims);
          let centreZ = viewZFromDepth(d, params.depthParams);
          for (var i = 0; i < count; i = i + 1) {
            if (tapCrosses(p + TAPS[i] * r, s, dims, centreId, centreZ, centre)) {
              return 1.0;
            }
          }
          return 0.0;
        }

        @fragment
        fn fs_edges(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
          let dims = vec2<i32>(params.viewport.xy);
          let p = vec2<i32>(fragPos.xy);
          let r = i32(round(params.edge.x));
          let high = params.edge.z > 0.5;
          let count = select(4, 8, high);

          // Samples of this texel on the plane of the first one reuse it; a
          // sample on another surface (an edge through the texel) fits its own.
          var first: Plane;
          var haveFirst = false;
          var onEdge = 0.0;
          for (var s = 0; s < EDGE_SAMPLES; s = s + 1) {
            let d = loadDepthSample(p, s);
            if (d <= BACKGROUND_DEPTH) {
              continue;
            }
            var centre = first;
            if (!haveFirst || !onPlane(first, p, s, d)) {
              centre = planeAt(p, s, d);
            }
            if (!haveFirst) {
              first = centre;
              haveFirst = true;
            }
            onEdge = onEdge + sampleOnEdge(p, s, dims, r, count, d, centre);
          }
          if (onEdge == 0.0) {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0);
          }

          let coverage = onEdge / f32(EDGE_SAMPLES);
          let weight = select(EDGE_LINE_WEIGHT_LOW, EDGE_LINE_WEIGHT_HIGH, high);
          let darken = clamp(coverage * weight * params.edge.y, 0.0, EDGE_MAX_DARKEN);
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
 * Coverage is a ring around the mask boundary: the distance to the nearest
 * mask pixel that differs from this one, searched within
 * `OUTLINE_SEARCH_RADIUS`, mapped through `outlineCoverage`
 * (`outline-params.ts`): full within `OUTLINE_WIDTH_PX` of the boundary on
 * either side, fading over the next pixel. (Averaging 4 neighbour taps
 * instead gives a straight edge only 1/4 coverage, a 1 px line too faint to
 * see.) No depth/normal reconstruction needed: a mask boundary is
 * unambiguous on its own.
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

        const OUTLINE_SEARCH_RADIUS: i32 = ${OUTLINE_SEARCH_RADIUS};
        const OUTLINE_WIDTH_PX: f32 = ${OUTLINE_WIDTH_PX.toFixed(3)};

        // Ring coverage astride the mask boundary (outline-params.ts's
        // outlineCoverage): distance to the nearest pixel whose channel
        // differs from this one, full within OUTLINE_WIDTH_PX, 0 one pixel on.
        fn boundaryCoverage(tex: texture_2d<f32>, channel: u32, p: vec2<i32>, dims: vec2<i32>) -> f32 {
          let center = loadClamped(tex, p, dims)[channel] > 0.5;
          var nearest = 1e4;
          for (var dy = -OUTLINE_SEARCH_RADIUS; dy <= OUTLINE_SEARCH_RADIUS; dy = dy + 1) {
            for (var dx = -OUTLINE_SEARCH_RADIUS; dx <= OUTLINE_SEARCH_RADIUS; dx = dx + 1) {
              if ((loadClamped(tex, p + vec2<i32>(dx, dy), dims)[channel] > 0.5) != center) {
                nearest = min(nearest, length(vec2<f32>(f32(dx), f32(dy))));
              }
            }
          }
          return clamp(OUTLINE_WIDTH_PX + 0.5 - nearest, 0.0, 1.0);
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
