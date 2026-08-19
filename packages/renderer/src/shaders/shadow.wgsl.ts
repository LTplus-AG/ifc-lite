/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sun shadow-map depth pre-pass shaders (issue #2670, Phase 2).
 *
 * Depth-only (no fragment stage): each entry point transforms a vertex to the
 * sun's light clip space and lets the depth test record the closest occluder.
 * There is ONE entry point per geometry path, and each MUST reproduce the
 * world-space position its main-shader counterpart computes, or that path
 * silently stops casting (the divergence class #2670's acceptance test guards):
 *
 *   • vs_shadow_flat       ← vs_main            worldPos = model * position
 *   • vs_shadow_quantized  ← vs_main_quantized  worldPos = model * dequant(q)
 *   • vs_shadow_instanced  ← vs_instanced       worldPos = instMat * position
 *   • vs_shadow_textured    ← textured vs_main    worldPos = model * position
 *
 * `lightViewProj` replaces the camera `viewProj`; `model`/`quantParams` come
 * per-draw via a dynamic-offset uniform (unused by the instanced path, whose
 * per-occurrence matrix arrives on vertex slot 1). The anti-z-fighting depth
 * nudge from the main shaders is deliberately omitted — it perturbs camera
 * clip depth for coplanar-face separation and has no meaning in light space.
 */
export const shadowShaderSource = `
        struct Light {
          lightViewProj: mat4x4<f32>,
        }
        @binding(0) @group(0) var<uniform> light: Light;

        struct Draw {
          model: mat4x4<f32>,
          // xyz = lattice-aligned quantMin (batch-origin-relative), w = step.
          // Read only by vs_shadow_quantized; zero for the other paths.
          quantParams: vec4<f32>,
        }
        @binding(1) @group(0) var<uniform> draw: Draw;

        struct FlatIn {
          @location(0) position: vec3<f32>,
        }

        struct QuantIn {
          @location(0) q: vec4<u32>,   // uint16x4: lattice x, y, z, packedOct
        }

        struct InstanceIn {
          @location(3) m0: vec4<f32>,
          @location(4) m1: vec4<f32>,
          @location(5) m2: vec4<f32>,
          @location(6) m3: vec4<f32>,
        }

        @vertex
        fn vs_shadow_flat(input: FlatIn) -> @builtin(position) vec4<f32> {
          let worldPos = draw.model * vec4<f32>(input.position, 1.0);
          return light.lightViewProj * worldPos;
        }

        @vertex
        fn vs_shadow_quantized(input: QuantIn) -> @builtin(position) vec4<f32> {
          let p = draw.quantParams.xyz
            + vec3<f32>(f32(input.q.x), f32(input.q.y), f32(input.q.z)) * draw.quantParams.w;
          let worldPos = draw.model * vec4<f32>(p, 1.0);
          return light.lightViewProj * worldPos;
        }

        @vertex
        fn vs_shadow_instanced(input: FlatIn, inst: InstanceIn) -> @builtin(position) vec4<f32> {
          let instMat = mat4x4<f32>(inst.m0, inst.m1, inst.m2, inst.m3);
          let worldPos = instMat * vec4<f32>(input.position, 1.0);
          return light.lightViewProj * worldPos;
        }

        @vertex
        fn vs_shadow_textured(input: FlatIn) -> @builtin(position) vec4<f32> {
          let worldPos = draw.model * vec4<f32>(input.position, 1.0);
          return light.lightViewProj * worldPos;
        }
`;
