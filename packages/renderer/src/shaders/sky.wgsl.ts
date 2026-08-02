/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Procedural sky background — a single fullscreen triangle drawn at the far
 * plane (reverse-Z: z = 0) before any geometry. Analytic zenith/horizon/
 * ground gradient plus a sun disc + glow, driven by the same sun direction
 * the geometry lighting uses.
 *
 * Tonemapping note: the geometry shader applies ACES + gamma at the end of
 * its fragment stage (not in a post pass), so the sky must apply the same
 * curve here or it would read as a different "film stock" than the model.
 */
export const skyShaderSource = `
        struct SkyUniforms {
          camRight: vec3<f32>,
          tanHalfFovX: f32,
          camUp: vec3<f32>,
          tanHalfFovY: f32,
          camForward: vec3<f32>,
          exposure: f32,
          sunDirection: vec3<f32>,
          sunIntensity: f32,
          zenithColor: vec3<f32>,
          _pad0: f32,
          horizonColor: vec3<f32>,
          _pad1: f32,
          groundColor: vec3<f32>,
          _pad2: f32,
        }
        @binding(0) @group(0) var<uniform> sky: SkyUniforms;

        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
          @location(0) ndc: vec2<f32>,
        }

        @vertex
        fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
          // Fullscreen triangle: (-1,-1), (3,-1), (-1,3).
          let x = f32((vi << 1u) & 2u) * 2.0 - 1.0;
          let y = f32(vi & 2u) * 2.0 - 1.0;
          var out: VertexOutput;
          // z = 0 is the far plane under reverse-Z, so any geometry drawn
          // later wins the depth test without the sky writing depth.
          out.position = vec4<f32>(x, y, 0.0, 1.0);
          out.ndc = vec2<f32>(x, y);
          return out;
        }

        // Same ACES filmic curve as the geometry fragment shader.
        fn acesTonemap(c: vec3<f32>) -> vec3<f32> {
          let a = 2.51;
          let b = 0.03;
          let cc = 2.43;
          let d = 0.59;
          let e = 0.14;
          return clamp((c * (a * c + b)) / (c * (cc * c + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
        }

        struct FragmentOutput {
          @location(0) color: vec4<f32>,
          // Matches the pass's object-id attachment clear value so the sky
          // never registers as a pickable entity.
          @location(1) objectIdEncoded: vec4<f32>,
        }

        @fragment
        fn fs_main(input: VertexOutput) -> FragmentOutput {
          // Per-pixel view ray from the camera basis. Used for orthographic
          // cameras too — parallel rays would collapse the sky to a single
          // colour, so a perspective-style fan reads better in both modes.
          let dir = normalize(
            sky.camForward
            + input.ndc.x * sky.tanHalfFovX * sky.camRight
            + input.ndc.y * sky.tanHalfFovY * sky.camUp
          );
          let elevation = dir.y;

          // Horizon → zenith gradient with a slow falloff near the horizon.
          let zenithMix = pow(clamp(elevation, 0.0, 1.0), 0.45);
          var color = mix(sky.horizonColor, sky.zenithColor, zenithMix);

          // Below the horizon: fade quickly into the ground colour.
          let groundMix = smoothstep(0.0, -0.1, elevation);
          color = mix(color, sky.groundColor, groundMix);

          // Sun disc + glow. The disc is slightly oversized vs the real
          // ~0.53° sun so it stays visible at typical canvas resolutions.
          let cosSun = dot(dir, sky.sunDirection);
          let disc = smoothstep(0.99985, 0.99995, cosSun);
          let glow = pow(max(cosSun, 0.0), 350.0) * 0.5
                   + pow(max(cosSun, 0.0), 24.0) * 0.12;
          // Hide the disc once the sun sets, and never draw it on the ground.
          let sunVisible = smoothstep(-0.06, 0.02, sky.sunDirection.y) * (1.0 - groundMix);
          let sunTint = vec3<f32>(1.0, 0.92, 0.78);
          color += (disc * 6.0 + glow) * max(sky.sunIntensity, 0.0) * sunVisible * sunTint;

          // Match the geometry pipeline: exposure → ACES → gamma.
          color *= sky.exposure;
          color = acesTonemap(color);
          color = pow(color, vec3<f32>(1.0 / 2.2));

          var out: FragmentOutput;
          out.color = vec4<f32>(color, 1.0);
          out.objectIdEncoded = vec4<f32>(0.0, 0.0, 0.0, 0.0);
          return out;
        }
      `;
