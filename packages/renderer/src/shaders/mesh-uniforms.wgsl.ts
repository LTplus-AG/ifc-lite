/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-mesh uniform block (`@group(0) @binding(0)`) and the section /
 * clip-box test that reads it, shared by `main.wgsl.ts` and the selection
 * mask fragment stage (#5390) so an outline is cut exactly where the
 * surface it traces is. Packing: `mesh-rte-uniforms.ts` / `index.ts`.
 */
import { MESH_FLAG_RTE_DRAWABLE } from '../mesh-rte-uniforms.js';

export const meshUniformsWgsl = `
        struct Uniforms {
          viewProj: mat4x4<f32>,
          model: mat4x4<f32>,
          baseColor: vec4<f32>,
          metallicRoughness: vec2<f32>, // x = metallic, y = roughness (mesh-material.ts)
          transmission: vec2<f32>,      // x = 1: authored translucent, drawn as glass; y = pad
          sectionPlane: vec4<f32>,      // xyz = plane normal, w = plane distance
          flags: vec4<u32>,             // x = isSelected, y = section/clip bits, z = edgeEnabled, w = edgeIntensityMilli
          clipBoxMin: vec4<f32>,        // xyz = clip-box min corner (world), w = pad
          clipBoxMax: vec4<f32>,        // xyz = clip-box max corner (world), w = pad
          quantParams: vec4<f32>, // local min xyz, lattice step w
          rteViewProj: mat4x4<f32>, // appended frame; bit 16 selects it
          drawableDeltaHigh: vec4<f32>,
          drawableDeltaLow: vec4<f32>,
          rteCameraHigh: vec4<f32>,
          rteCameraLow: vec4<f32>,
        }
        @binding(0) @group(0) var<uniform> uniforms: Uniforms;
        const RTE_DRAWABLE_FLAG: u32 = ${MESH_FLAG_RTE_DRAWABLE}u;

        // The fragment position the section/crop tests run in: camera-relative
        // for RTE drawables (the packer writes plane and box in that frame),
        // world space otherwise.
        fn clipSpacePos(worldPos: vec3<f32>, eyePos: vec3<f32>) -> vec3<f32> {
          return select(worldPos, eyePos, (uniforms.flags.x & RTE_DRAWABLE_FLAG) != 0u);
        }

        // True when p is cut away: ABOVE the section plane (flags.y bit 0 =
        // enabled, bit 1 = flipped) or OUTSIDE the clip box (bit 2).
        fn sectionClipped(p: vec3<f32>) -> bool {
          if ((uniforms.flags.y & 1u) == 1u) {
            let side = select(1.0, -1.0, (uniforms.flags.y & 2u) == 2u);
            if ((dot(p, uniforms.sectionPlane.xyz) - uniforms.sectionPlane.w) * side > 0.0) { return true; }
          }
          if ((uniforms.flags.y & 4u) != 0u) {
            if (any(p < uniforms.clipBoxMin.xyz) || any(p > uniforms.clipBoxMax.xyz)) { return true; }
          }
          return false;
        }
`;
