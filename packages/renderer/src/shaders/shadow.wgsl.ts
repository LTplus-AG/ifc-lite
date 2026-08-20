/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sun shadow-map depth pre-pass shaders (issue #2670, Phase 2).
 *
 * Depth-only: each entry point transforms a vertex to the sun's light clip
 * space and lets the depth test record the closest occluder. There is ONE
 * entry point per geometry path, and each MUST reproduce the world-space
 * position its main-shader counterpart computes, or that path silently stops
 * casting (the divergence class #2670's acceptance test guards):
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
 *
 * CLIPPING. Every entry point also passes world position to `fs_shadow_clip`,
 * which re-applies the section plane and clip box exactly as `fs_main` does,
 * so geometry a section cut removed from view stops casting too (otherwise the
 * cut-away roof keeps shadowing the floor it no longer covers). The fragment
 * stage is only attached when a clip is actually active — with no clipping the
 * pipelines stay fragment-less, keeping the double-speed depth-only path — and
 * the unused `worldPos` output on those pipelines costs an interpolator, not a
 * shader stage.
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

        struct Clip {
          // xyz = plane normal, w = plane distance (world space).
          sectionPlane: vec4<f32>,
          clipBoxMin: vec4<f32>,
          clipBoxMax: vec4<f32>,
          // x packs: bit 0 = section enabled, bit 1 = section flipped,
          //          bit 2 = clip box enabled. Mirrors main.wgsl's flags.y.
          flags: vec4<u32>,
        }
        @binding(2) @group(0) var<uniform> clip: Clip;

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
          // Per-occurrence flags lane (bit 1 = hidden), same instance buffer the
          // colour pass reads. Locations 7 (entityId) and 8 (rgba) are unused by
          // the depth pass and left unbound.
          @location(9) flags: u32,
        }

        struct ShadowOut {
          @builtin(position) position: vec4<f32>,
          @location(0) worldPos: vec3<f32>,
        }

        fn emit(worldPos: vec4<f32>) -> ShadowOut {
          var out: ShadowOut;
          out.position = light.lightViewProj * worldPos;
          out.worldPos = worldPos.xyz;
          return out;
        }

        @vertex
        fn vs_shadow_flat(input: FlatIn) -> ShadowOut {
          return emit(draw.model * vec4<f32>(input.position, 1.0));
        }

        @vertex
        fn vs_shadow_quantized(input: QuantIn) -> ShadowOut {
          let p = draw.quantParams.xyz
            + vec3<f32>(f32(input.q.x), f32(input.q.y), f32(input.q.z)) * draw.quantParams.w;
          return emit(draw.model * vec4<f32>(p, 1.0));
        }

        @vertex
        fn vs_shadow_instanced(input: FlatIn, inst: InstanceIn) -> ShadowOut {
          // A hidden / isolation-excluded occurrence (flags bit 1) must not cast:
          // the colour pass discards it in fs_main, so collapse it to a zero-area
          // triangle here (every vertex to one clip point) — the rasterizer drops
          // it and it writes no depth. Mirrors main.wgsl's instSelected & 2u check.
          if ((inst.flags & 2u) != 0u) {
            var out: ShadowOut;
            out.position = vec4<f32>(0.0, 0.0, 0.0, 1.0);
            out.worldPos = vec3<f32>(0.0, 0.0, 0.0);
            return out;
          }
          let instMat = mat4x4<f32>(inst.m0, inst.m1, inst.m2, inst.m3);
          return emit(instMat * vec4<f32>(input.position, 1.0));
        }

        @vertex
        fn vs_shadow_textured(input: FlatIn) -> ShadowOut {
          return emit(draw.model * vec4<f32>(input.position, 1.0));
        }

        // Clipped variant: discard before the depth write, so a clipped-away
        // occluder leaves the shadow map untouched. Kept byte-for-byte in step
        // with the fs_main section/clip-box branches.
        @fragment
        fn fs_shadow_clip(@location(0) worldPos: vec3<f32>) {
          if ((clip.flags.x & 1u) == 1u) {
            let side = select(1.0, -1.0, (clip.flags.x & 2u) == 2u);
            let distToPlane = (dot(worldPos, clip.sectionPlane.xyz) - clip.sectionPlane.w) * side;
            if (distToPlane > 0.0) {
              discard;
            }
          }
          if ((clip.flags.x & 4u) != 0u) {
            if (any(worldPos < clip.clipBoxMin.xyz) || any(worldPos > clip.clipBoxMax.xyz)) {
              discard;
            }
          }
        }
`;
