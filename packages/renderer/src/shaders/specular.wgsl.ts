/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Specular reflection for the geometry fragment stage (#5386).
 *
 * Two terms, both in the units of `fs_main`'s `lightTerm`, so the caller
 * scales them by the same exposure and `IRRADIANCE_CALIBRATION` as the
 * diffuse light and every preset stays consistent:
 *
 *  - the sun: a Cook-Torrance lobe (GGX distribution, Smith-Schlick
 *    visibility, Schlick Fresnel). `fs_main` lights a Lambertian albedo as
 *    `albedo * intensity`, i.e. the sun's irradiance is `pi * intensity`, so
 *    the lobe is scaled by the same `pi` and a white dielectric reflects no
 *    more than physics allows next to its diffuse.
 *  - the environment: the same two-colour hemisphere that lights the diffuse
 *    ambient, read along the reflection vector and weighted by the
 *    split-sum environment BRDF (Karis's analytic fit, "Physically Based
 *    Shading on Mobile", 2014). The fit already accounts for the lobe's
 *    shadowing, so a rough surface picks up almost nothing at grazing angles
 *    while a smooth one (glass) turns into a mirror there.
 *
 * `reflectance` is that directional albedo of the specular lobe. The caller
 * takes it off the diffuse (`1 - reflectance`), so a highlight never adds
 * energy on top of a full diffuse, and glass uses it as the light it no
 * longer transmits.
 *
 * Reads the `env` lighting uniform, like `sunShadowFactor`.
 */

/**
 * Smallest roughness the lobe is evaluated at. Below this the GGX peak is a
 * sub-pixel spike that flickers from frame to frame. The value is Filament's
 * `MIN_PERCEPTUAL_ROUGHNESS` for 32-bit floats.
 */
export const MIN_SPECULAR_ROUGHNESS = 0.045;

export const specularWgsl = `
        const MIN_SPECULAR_ROUGHNESS: f32 = ${MIN_SPECULAR_ROUGHNESS};
        const DIELECTRIC_F0: f32 = 0.04;
        const PI: f32 = 3.14159265;

        fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
          return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
        }

        fn distributionGGX(NdotH: f32, roughness: f32) -> f32 {
          let a = roughness * roughness;
          let a2 = a * a;
          let NdotH2 = NdotH * NdotH;
          let denomBase = (NdotH2 * (a2 - 1.0) + 1.0);
          return a2 / max(PI * denomBase * denomBase, 0.0000001);
        }

        fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
          let r = (roughness + 1.0);
          let k = (r * r) / 8.0;
          return NdotV / max(NdotV * (1.0 - k) + k, 0.0000001);
        }

        fn geometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
          return geometrySchlickGGX(NdotL, roughness) * geometrySchlickGGX(NdotV, roughness);
        }

        // Split-sum environment BRDF, analytic fit (Karis 2014).
        fn envBrdfApprox(F0: vec3<f32>, roughness: f32, NdotV: f32) -> vec3<f32> {
          let r = roughness * vec4<f32>(-1.0, -0.0275, -0.572, 0.022) + vec4<f32>(1.0, 0.0425, 1.04, -0.04);
          let a004 = min(r.x * r.x, exp2(-9.28 * NdotV)) * r.x + r.y;
          let ab = vec2<f32>(-1.04, 1.04) * a004 + r.zw;
          return F0 * ab.x + ab.y;
        }

        struct SurfaceSpecular {
          // Reflected light, in lightTerm units (unexposed, uncalibrated).
          light: vec3<f32>,
          // Directional albedo of the specular lobe for this view.
          reflectance: vec3<f32>,
        }

        // N and V are unit vectors; V points from the surface to the eye.
        // sunLight is the sun's diffuse-equivalent intensity: sunColor *
        // sunIntensity * sunShadow, exactly what scales the diffuse sun term.
        fn surfaceSpecular(
          N: vec3<f32>,
          V: vec3<f32>,
          albedo: vec3<f32>,
          metallic: f32,
          roughnessIn: f32,
          sunLight: vec3<f32>,
        ) -> SurfaceSpecular {
          var out: SurfaceSpecular;
          let NdotV = dot(N, V);
          // A face turned away from the eye is its back side: nothing it
          // reflects can reach the eye, and its diffuse keeps full weight.
          if (NdotV <= 0.0) {
            out.light = vec3<f32>(0.0);
            out.reflectance = vec3<f32>(0.0);
            return out;
          }
          let roughness = clamp(roughnessIn, MIN_SPECULAR_ROUGHNESS, 1.0);
          let F0 = mix(vec3<f32>(DIELECTRIC_F0), albedo, metallic);

          let L = env.sunDirection;
          let rawNdotL = dot(N, L);
          let NdotL = max(rawNdotL, 0.0);
          // A face the sun is behind (rawNdotL <= 0) contributes nothing to
          // the direct lobe anyway (NdotL clamps it to 0 below), but V + L
          // can be exactly zero there — the sun exactly opposite the eye
          // reflection, e.g. N = V = (0,-1,0), sun = (0,1,0), both satisfy
          // NdotV > 0 above. normalize(vec3(0)) is NaN in WGSL, and NaN * 0
          // is NaN, not 0, so it would poison sun and everything summed with
          // it instead of being multiplied away. Skip the half-vector
          // entirely in that case rather than relying on the NdotL factor.
          var sun = vec3<f32>(0.0);
          if (rawNdotL > 0.0) {
            let H = normalize(V + L);
            let D = distributionGGX(max(dot(N, H), 0.0), roughness);
            let G = geometrySmith(NdotV, NdotL, roughness);
            let F = fresnelSchlick(max(dot(V, H), 0.0), F0);
            // BRDF * NdotL * (pi * intensity); the NdotL cancels the BRDF's.
            sun = F * (D * G * PI / (4.0 * NdotV)) * sunLight;
          }

          // The hemisphere ambient, looked up along the reflection. A rough
          // lobe gathers from around the normal, so lean the lookup toward N.
          let R = reflect(-V, N);
          let Rd = normalize(mix(R, N, roughness * roughness));
          let sky = mix(env.groundColor, env.skyColor, Rd.y * 0.5 + 0.5) * env.ambientIntensity;
          let reflectance = envBrdfApprox(F0, roughness, NdotV);

          out.light = sun + sky * reflectance;
          out.reflectance = reflectance;
          return out;
        }
`;
