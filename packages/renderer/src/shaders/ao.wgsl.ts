/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Screen-space ambient occlusion (#5384), SAO-style, in four fullscreen
 * passes that share this module:
 *
 *  1. `fs_ao` (AO resolution): reconstruct the view-space position and
 *     normal from depth, then take `samples` taps on a per-pixel rotated
 *     spiral whose radius is `radius` world units projected to pixels. A tap
 *     occludes by how far it rises above the tangent plane (cosine, minus a
 *     bias), fading to zero at `radius` so distant geometry does not count.
 *     Writes (occlusion, linear depth).
 *  2. `fs_blur_h`, 3. `fs_blur_v`: separable 9-tap bilateral blur that stops
 *     at depth discontinuities.
 *  4. `fs_composite` (full resolution): depth-aware upsample, then output
 *     the darkening as alpha for a multiply blend. Background pixels (clear
 *     depth) output 0, so the sky and the clear colour are never darkened.
 *
 * `ao-params.ts` owns the uniform layout (`AO_UNIFORM_LAYOUT`) and the
 * kernel; `depth-reconstruct.wgsl.ts` owns the reconstruction.
 */
import { AO_GAIN, AO_MAX_DARKEN } from '../ao-params.js';
import { depthReconstructWgsl, depthTextureWgsl } from './depth-reconstruct.wgsl.js';

export function aoShaderSource(multisampled: boolean): string {
  return `
        struct AoParams {
          depthParams: vec4<f32>,  // m10, m11, m14, m15
          xyParams: vec4<f32>,     // m0, m5, m12, m13
          viewport: vec4<f32>,     // full-res width, height, 1/width, 1/height
          ao: vec4<f32>,           // radius (world), px per world unit at w=1, max radius px, intensity
          misc: vec4<f32>,         // resolution divisor, samples, cosine bias, depth tolerance
          kernel: array<vec4<f32>, 8>, // 16 unit-disk offsets, two per vec4
        }

        ${depthTextureWgsl(0, multisampled)}
        @group(0) @binding(1) var<uniform> params: AoParams;
        @group(0) @binding(2) var aoIn: texture_2d<f32>;

        ${depthReconstructWgsl}

        const TAU: f32 = 6.28318530718;
        const AO_GAIN: f32 = ${AO_GAIN.toFixed(3)};
        const AO_MAX_DARKEN: f32 = ${AO_MAX_DARKEN.toFixed(3)};

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

        fn viewPosAt(ip: vec2<i32>, d: f32) -> vec3<f32> {
          return viewPositionFromDepth(ndcFromPixel(ip, params.viewport.zw), d, params.depthParams, params.xyParams);
        }

        // A neighbour for the normal. Background pushes it far away, so
        // normalFromNeighbours takes the other side.
        fn neighbourPos(ip: vec2<i32>, center: vec3<f32>) -> vec3<f32> {
          let d = loadDepth(ip);
          if (d <= BACKGROUND_DEPTH) {
            return center - vec3<f32>(0.0, 0.0, 1e6);
          }
          return viewPosAt(ip, d);
        }

        fn kernelTap(i: u32) -> vec2<f32> {
          let v = params.kernel[i / 2u];
          return select(v.xy, v.zw, (i & 1u) == 1u);
        }

        // Interleaved gradient noise (Jimenez 2014): a per-pixel rotation the
        // 9-tap blur removes without a visible pattern.
        fn interleavedGradientNoise(p: vec2<f32>) -> f32 {
          return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
        }

        @fragment
        fn fs_ao(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
          let divisor = i32(params.misc.x);
          let p = vec2<i32>(fragPos.xy) * divisor;
          let dims = vec2<i32>(params.viewport.xy);
          let d = loadDepth(p);
          if (d <= BACKGROUND_DEPTH) {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0);
          }
          let P = viewPosAt(p, d);
          let N = normalFromNeighbours(
            P,
            neighbourPos(p + vec2<i32>(1, 0), P),
            neighbourPos(p - vec2<i32>(1, 0), P),
            neighbourPos(p + vec2<i32>(0, 1), P),
            neighbourPos(p - vec2<i32>(0, 1), P),
          );
          let depthKey = -P.z;

          let radius = params.ao.x;
          let w = clipWFromViewZ(P.z, params.depthParams);
          let radiusPx = min(radius * params.ao.y / w, params.ao.z);
          if (radiusPx < 1.0) {
            // Smaller than a pixel: nothing to resolve at this distance.
            return vec4<f32>(0.0, depthKey, 0.0, 0.0);
          }

          let angle = interleavedGradientNoise(fragPos.xy) * TAU;
          let rot = vec2<f32>(cos(angle), sin(angle));
          let invR2 = 1.0 / (radius * radius);
          let bias = params.misc.z;
          let samples = u32(params.misc.y);
          var occlusion = 0.0;
          for (var i = 0u; i < samples; i = i + 1u) {
            let k = kernelTap(i);
            let offset = vec2<f32>(k.x * rot.x - k.y * rot.y, k.x * rot.y + k.y * rot.x) * radiusPx;
            let q = p + vec2<i32>(round(offset));
            if (any(q < vec2<i32>(0)) || any(q >= dims)) {
              continue;
            }
            let dq = loadDepth(q);
            if (dq <= BACKGROUND_DEPTH) {
              continue;
            }
            let v = viewPosAt(q, dq) - P;
            let vv = dot(v, v);
            // Range check: taps beyond the world radius do not occlude.
            let falloff = max(1.0 - vv * invR2, 0.0);
            let cosine = dot(v, N) * inverseSqrt(vv + 1e-8);
            occlusion = occlusion + falloff * max(cosine - bias, 0.0);
          }
          occlusion = occlusion / (f32(samples) * (1.0 - bias));
          return vec4<f32>(occlusion, depthKey, 0.0, 0.0);
        }

        // Relative depth closeness in [0, 1]: 1 on the same surface, 0 across
        // a step larger than the tolerance.
        fn depthWeight(key: f32, centerKey: f32) -> f32 {
          return max(0.0, 1.0 - abs(key - centerKey) / (centerKey * params.misc.w));
        }

        fn bilateralBlur(t: vec2<i32>, dir: vec2<i32>) -> vec4<f32> {
          let center = textureLoad(aoIn, t, 0);
          if (center.y <= 0.0) {
            return center;
          }
          let dims = vec2<i32>(textureDimensions(aoIn));
          // Gaussian, sigma ~2 texels. A var: it is indexed at runtime.
          var gauss = array<f32, 5>(0.2270, 0.1945, 0.1216, 0.0540, 0.0162);
          var sum = center.x * gauss[0];
          var wsum = gauss[0];
          for (var i = 1; i <= 4; i = i + 1) {
            for (var s = -1; s <= 1; s = s + 2) {
              let q = t + dir * (i * s);
              if (any(q < vec2<i32>(0)) || any(q >= dims)) {
                continue;
              }
              let tap = textureLoad(aoIn, q, 0);
              if (tap.y <= 0.0) {
                continue;
              }
              let wgt = gauss[i] * depthWeight(tap.y, center.y);
              sum = sum + tap.x * wgt;
              wsum = wsum + wgt;
            }
          }
          return vec4<f32>(sum / wsum, center.y, 0.0, 0.0);
        }

        @fragment
        fn fs_blur_h(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
          return bilateralBlur(vec2<i32>(fragPos.xy), vec2<i32>(1, 0));
        }

        @fragment
        fn fs_blur_v(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
          return bilateralBlur(vec2<i32>(fragPos.xy), vec2<i32>(0, 1));
        }

        // Joint bilateral upsample: the (up to) four AO texels around this
        // pixel, weighted bilinearly and by depth closeness. When none is on
        // this pixel's surface, the closest in depth wins.
        fn upsampledOcclusion(p: vec2<i32>, key: f32) -> f32 {
          let divisor = params.misc.x;
          if (divisor <= 1.0) {
            return textureLoad(aoIn, p, 0).x;
          }
          let dims = vec2<i32>(textureDimensions(aoIn));
          // AO texel t was computed at full-res pixel t * divisor.
          let f = vec2<f32>(p) / divisor;
          let base = vec2<i32>(floor(f));
          let fr = f - floor(f);
          var sum = 0.0;
          var wsum = 0.0;
          var nearest = 0.0;
          var nearestDiff = 1e30;
          for (var j = 0; j < 4; j = j + 1) {
            let o = vec2<i32>(j & 1, j >> 1u);
            let q = clamp(base + o, vec2<i32>(0), dims - 1);
            let tap = textureLoad(aoIn, q, 0);
            let bw = select(1.0 - fr.x, fr.x, o.x == 1) * select(1.0 - fr.y, fr.y, o.y == 1);
            let wgt = bw * depthWeight(tap.y, key);
            sum = sum + tap.x * wgt;
            wsum = wsum + wgt;
            let diff = abs(tap.y - key);
            if (diff < nearestDiff) {
              nearestDiff = diff;
              nearest = tap.x;
            }
          }
          return select(nearest, sum / wsum, wsum > 1e-3);
        }

        @fragment
        fn fs_composite(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
          let p = vec2<i32>(fragPos.xy);
          let d = loadDepth(p);
          if (d <= BACKGROUND_DEPTH) {
            return vec4<f32>(0.0, 0.0, 0.0, 0.0);
          }
          let key = -viewZFromDepth(d, params.depthParams);
          let occlusion = upsampledOcclusion(p, key);
          let darken = clamp(occlusion * AO_GAIN * params.ao.w, 0.0, AO_MAX_DARKEN);
          return vec4<f32>(0.0, 0.0, 0.0, darken);
        }
`;
}
