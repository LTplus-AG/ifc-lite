/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main PBR rendering shader for IFC geometry.
 * Features: PBR lighting, section plane clipping, selection highlight,
 * glass fresnel, ACES tone mapping, screen-space edge enhancement.
 */
export const mainShaderSource = `
        struct Uniforms {
          viewProj: mat4x4<f32>,
          model: mat4x4<f32>,
          baseColor: vec4<f32>,
          metallicRoughness: vec2<f32>, // x = metallic, y = roughness
          _padding1: vec2<f32>,
          sectionPlane: vec4<f32>,      // xyz = plane normal, w = plane distance
          flags: vec4<u32>,             // x = isSelected, y = sectionEnabled, z = edgeEnabled, w = edgeIntensityMilli
        }
        @binding(0) @group(0) var<uniform> uniforms: Uniforms;

        struct VertexInput {
          @location(0) position: vec3<f32>,
          @location(1) normal: vec3<f32>,
          @location(2) entityId: u32,
        }

        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
          @location(0) worldPos: vec3<f32>,
          @location(1) normal: vec3<f32>,
          @location(2) @interpolate(flat) entityId: u32,
          @location(3) viewPos: vec3<f32>,  // For edge detection
        }

        @vertex
        fn vs_main(input: VertexInput, @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
          var output: VertexOutput;
          let worldPos = uniforms.model * vec4<f32>(input.position, 1.0);
          output.position = uniforms.viewProj * worldPos;
          // Anti z-fighting: deterministic depth nudge per entity.
          // Knuth multiplicative hash spreads sequential IDs across 0-255
          // so coplanar faces from different entities always get distinct depths.
          // At 1e-6 per step the max world-space offset is <3mm at 10m — invisible.
          let zHash = (input.entityId * 2654435761u) & 255u;
          output.position.z *= 1.0 + f32(zHash) * 1e-6;
          output.worldPos = worldPos.xyz;
          output.normal = normalize((uniforms.model * vec4<f32>(input.normal, 0.0)).xyz);
          output.entityId = input.entityId;
          // Store view-space position for edge detection
          output.viewPos = (uniforms.viewProj * worldPos).xyz;
          return output;
        }

        // PBR helper functions
        fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
          return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
        }

        fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
          let a = roughness * roughness;
          let a2 = a * a;
          let NdotH2 = NdotH * NdotH;
          let num = a2;
          let denomBase = (NdotH2 * (a2 - 1.0) + 1.0);
          let denom = 3.14159265 * denomBase * denomBase;
          return num / max(denom, 0.0000001);
        }

        fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
          let r = (roughness + 1.0);
          let k = (r * r) / 8.0;
          let num = NdotV;
          let denom = NdotV * (1.0 - k) + k;
          return num / max(denom, 0.0000001);
        }

        fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
          let ggx2 = geometrySchlickGGX(NdotV, roughness);
          let ggx1 = geometrySchlickGGX(NdotL, roughness);
          return ggx1 * ggx2;
        }

        fn encodeId24(id: u32) -> vec4<f32> {
          let r = f32((id >> 16u) & 255u) / 255.0;
          let g = f32((id >> 8u) & 255u) / 255.0;
          let b = f32(id & 255u) / 255.0;
          return vec4<f32>(r, g, b, 1.0);
        }

        struct FragmentOutput {
          @location(0) color: vec4<f32>,
          @location(1) objectIdEncoded: vec4<f32>,
        }

        @fragment
        fn fs_main(input: VertexOutput) -> FragmentOutput {
          // Section plane clipping - discard fragments ABOVE the plane.
          // flags.y packs two bits: bit 0 = enabled, bit 1 = flipped.
          let sectionEnabled = (uniforms.flags.y & 1u) == 1u;
          if (sectionEnabled) {
            let planeNormal = uniforms.sectionPlane.xyz;
            let planeDistance = uniforms.sectionPlane.w;
            let flipped = (uniforms.flags.y & 2u) == 2u;
            let side = select(1.0, -1.0, flipped);
            let distToPlane = (dot(input.worldPos, planeNormal) - planeDistance) * side;
            if (distToPlane > 0.0) {
              discard;
            }
          }

          // Compute normal — with fallback for zero normals
          // dpdx/dpdy must be called outside non-uniform control flow (WGSL spec),
          // so we compute the flat normal unconditionally and select below.
          let faceN = cross(dpdx(input.worldPos), dpdy(input.worldPos));
          var N = input.normal;
          let nLen2 = dot(N, N);
          if (nLen2 < 0.0001) {
            // Fallback: use flat normal from screen-space derivatives
            let fLen2 = dot(faceN, faceN);
            N = select(vec3<f32>(0.0, 1.0, 0.0), faceN * inverseSqrt(fLen2), fLen2 > 1e-10);
          } else {
            N = N * inverseSqrt(nLen2);
          }

          // Enhanced lighting with multiple sources
          let sunLight = normalize(vec3<f32>(0.5, 1.0, 0.3));  // Main directional light
          let fillLight = normalize(vec3<f32>(-0.5, 0.3, -0.3));  // Fill light
          let rimLight = normalize(vec3<f32>(0.0, 0.2, -1.0));  // Rim light for edge definition

          // Hemisphere ambient - reduced for less washed-out look
          let skyColor = vec3<f32>(0.3, 0.35, 0.4);  // Darker sky
          let groundColor = vec3<f32>(0.15, 0.1, 0.08);  // Darker ground
          let hemisphereFactor = N.y * 0.5 + 0.5;
          let ambient = mix(groundColor, skyColor, hemisphereFactor) * 0.25;

          // Two-sided sun light so inner faces (I-beam channels) stay visible
          let NdotL = abs(dot(N, sunLight));
          let wrap = 0.3;
          let diffuseSun = max((NdotL + wrap) / (1.0 + wrap), 0.0) * 0.55;

          // Fill light - two-sided
          let NdotFill = abs(dot(N, fillLight));
          let diffuseFill = NdotFill * 0.15;

          // Rim light for edge definition
          let NdotRim = max(dot(N, rimLight), 0.0);
          let rim = pow(NdotRim, 4.0) * 0.15;

          var baseColor = uniforms.baseColor.rgb;

          // Detect if the color is close to white/gray (low saturation)
          let baseGray = dot(baseColor, vec3<f32>(0.299, 0.587, 0.114));
          let baseSaturation = length(baseColor - vec3<f32>(baseGray)) / max(baseGray, 0.001);
          let isWhiteish = 1.0 - smoothstep(0.0, 0.3, baseSaturation);

          // Darken whites/grays more to reduce washed-out appearance
          baseColor = mix(baseColor, baseColor * 0.7, isWhiteish * 0.4);

          // Combine all lighting
          var color = baseColor * (ambient + diffuseSun + diffuseFill + rim);

          // Selection highlight - add glow/fresnel effect
          if (uniforms.flags.x == 1u) {
            let V = normalize(-input.worldPos);
            let NdotV = max(dot(N, V), 0.0);
            let fresnel = pow(1.0 - NdotV, 2.0);
            let highlightColor = vec3<f32>(0.3, 0.6, 1.0);
            color = mix(color, highlightColor, fresnel * 0.5 + 0.2);
          }

          // Beautiful fresnel effect for transparent materials (glass)
          // Skip when selected — the glass shine and desaturation wash out the
          // blue highlight, making it appear white instead of blue.
          // Also force alpha to 1.0 for selected objects so the highlight is
          // fully opaque (the selection pipeline has no alpha blending).
          var finalAlpha = select(uniforms.baseColor.a, 1.0, uniforms.flags.x == 1u);
          if (finalAlpha < 0.99 && uniforms.flags.x != 1u) {
            // Calculate view direction for fresnel
            let V = normalize(-input.worldPos);
            let NdotV = max(dot(N, V), 0.0);

            // Enhanced fresnel effect - stronger at edges (grazing angles)
            // Using Schlick's approximation for realistic glass reflection
            let fresnelPower = 1.5; // Higher = softer edge reflections
            let fresnel = pow(1.0 - NdotV, fresnelPower);

            // Glass reflection tint (sky/environment reflection at edges)
            let reflectionTint = vec3<f32>(0.92, 0.96, 1.0);  // Cool sky reflection
            let reflectionStrength = fresnel * 0.6;  // Strong edge reflections

            // Mix in reflection tint at edges
            color = mix(color, color * reflectionTint, reflectionStrength);

            // Add realistic glass shine - brighter at edges where light reflects
            let glassShine = fresnel * 0.12;
            color += glassShine;

            // Slight desaturation at edges (glass reflects environment, not just color)
            let edgeDesaturation = fresnel * 0.25;
            let gray = dot(color, vec3<f32>(0.299, 0.587, 0.114));
            color = mix(color, vec3<f32>(gray), edgeDesaturation);

            // Make glass more transparent (reduce opacity by 30%)
            finalAlpha = finalAlpha * 0.7;
          }

          // Exposure adjustment - darken overall
          color *= 0.85;

          // Contrast enhancement
          color = (color - 0.5) * 1.15 + 0.5;
          color = max(color, vec3<f32>(0.0));

          // Saturation boost - stronger for colored surfaces, less for whites
          let gray = dot(color, vec3<f32>(0.299, 0.587, 0.114));
          let satBoost = mix(1.4, 1.1, isWhiteish);  // More saturation for colored surfaces
          color = mix(vec3<f32>(gray), color, satBoost);

          // ACES filmic tone mapping
          let a = 2.51;
          let b = 0.03;
          let c = 2.43;
          let d = 0.59;
          let e = 0.14;
          color = clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));

          // Subtle edge enhancement using screen-space derivatives
          let depthGradient = length(vec2<f32>(
            dpdx(input.viewPos.z),
            dpdy(input.viewPos.z)
          ));
          let normalGradient = length(vec2<f32>(
            length(dpdx(input.normal)),
            length(dpdy(input.normal))
          ));

          if (uniforms.flags.z == 1u) {
            // Threshold filters subtle normal discontinuities at internal
            // triangle edges between coplanar entities in the same batch.
            let edgeFactor = smoothstep(0.02, 0.12, depthGradient * 10.0 + normalGradient * 5.0);
            let edgeIntensity = f32(uniforms.flags.w) / 1000.0;
            let edgeDarkenStrength = clamp(0.25 * edgeIntensity, 0.0, 0.85);
            let edgeDarken = mix(1.0, 1.0 - edgeDarkenStrength, edgeFactor);
            color *= edgeDarken;
          }

          // Gamma correction
          color = pow(color, vec3<f32>(1.0 / 2.2));

          var out: FragmentOutput;
          out.color = vec4<f32>(color, finalAlpha);
          out.objectIdEncoded = encodeId24(input.entityId);
          return out;
        }
      `;
