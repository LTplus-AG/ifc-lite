/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** RTE vertex reconstruction and shadow sampling composed into the main WGSL. */

export const mainRteWgsl = `
        fn rtePosition(local: vec3<f32>) -> vec4<f32> {
          let linear = (uniforms.model * vec4<f32>(local, 0.0)).xyz;
          return rteWorldPosition(linear, RteDrawableUniform(
            uniforms.drawableDeltaHigh,
            uniforms.drawableDeltaLow,
          ));
        }
        fn rteInstancePosition(local: vec3<f32>, anchorHigh: vec3<f32>, anchorLow: vec3<f32>) -> vec4<f32> {
          return rteWorldPosition(local, RteDrawableUniform(
            vec4<f32>(anchorHigh, 0.0),
            vec4<f32>(anchorLow, 0.0),
          ));
        }`;

export const mainShadowWgsl = `
        @binding(1) @group(1) var shadowMap: texture_depth_2d;
        @binding(2) @group(1) var shadowCmp: sampler_comparison;
        struct Shadow { lightViewProj: mat4x4<f32>, params: vec4<f32>, params2: vec4<f32>, }
        @binding(3) @group(1) var<uniform> shadowU: Shadow;
        const SHADOW_POISSON = array<vec2<f32>, 12>(
          vec2<f32>(-0.326, -0.406), vec2<f32>(-0.840, -0.074), vec2<f32>(-0.696,  0.457),
          vec2<f32>(-0.203,  0.621), vec2<f32>( 0.962, -0.195), vec2<f32>( 0.473, -0.480),
          vec2<f32>( 0.519,  0.767), vec2<f32>( 0.185, -0.893), vec2<f32>( 0.507,  0.064),
          vec2<f32>( 0.896,  0.412), vec2<f32>(-0.322, -0.933), vec2<f32>(-0.792, -0.598),
        );
        fn sunShadowFactor(eyePos: vec3<f32>, N: vec3<f32>, fragCoord: vec2<f32>) -> f32 {
          if (shadowU.params.y < 0.5) { return 1.0; }
          let L = normalize(env.sunDirection);
          let Ns = N * select(-1.0, 1.0, dot(N, L) >= 0.0);
          let biased = eyePos + Ns * shadowU.params.z;
          let clip = shadowU.lightViewProj * vec4<f32>(biased, 1.0);
          let ndc = clip.xyz / clip.w;
          let uv = vec2<f32>(ndc.x * 0.5 + 0.5, ndc.y * -0.5 + 0.5);
          let inBounds = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0 && ndc.z > 0.0;
          if (!inBounds) { return 1.0; }
          let NdotL = max(dot(Ns, L), 0.0);
          let slope = clamp(sqrt(max(1.0 - NdotL * NdotL, 0.0)) / max(NdotL, 0.1), 1.0, 12.0);
          let refDepth = ndc.z + shadowU.params2.x * slope * (1.0 + shadowU.params.w);
          let radius = shadowU.params.x * shadowU.params.w;
          let ign = fract(52.9829189 * fract(dot(fragCoord, vec2<f32>(0.06711056, 0.00583715))));
          let ang = ign * 6.2831853;
          let cr = cos(ang); let sr = sin(ang); var sum = 0.0;
          for (var i = 0; i < 12; i = i + 1) {
            let p = SHADOW_POISSON[i];
            let off = vec2<f32>(p.x * cr - p.y * sr, p.x * sr + p.y * cr) * radius;
            sum = sum + textureSampleCompareLevel(shadowMap, shadowCmp, uv + off, refDepth);
          }
          return mix(1.0, sum / 12.0, smoothstep(0.0, 0.3, NdotL));
        }`;
