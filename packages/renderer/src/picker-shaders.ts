/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The GPU picker's WGSL, lifted out of `picker.ts`: the flat-mesh pick pass and
 * the instanced-occurrence pick pass. Both mirror the colour pass's clip
 * discards (section plane, the cutting planes beyond it, crop box), so a click
 * cannot select a fragment the user has cut away.
 */

import { relativeToEyeWgsl } from './shaders/relative-to-eye.wgsl.js';
import { extraClipWgsl } from './extra-clip-planes.js';

/** Flat meshes: one dynamic-offset uniform slot per mesh, expressIds in a storage buffer. */
export const flatPickShaderWgsl = `
        ${relativeToEyeWgsl}
        ${extraClipWgsl}
        struct Uniforms {
          viewProj: mat4x4<f32>, // translation-free RTE projection
          model: mat4x4<f32>,    // linear transform; translation lives in originHigh/Low
          clipBoxMin: vec4<f32>,   // xyz = min corner (world), w = pad
          clipBoxMax: vec4<f32>,   // xyz = max corner (world), w = pad
          sectionPlane: vec4<f32>, // xyz = plane normal, w = plane distance
          clipFlags: vec4<u32>,    // x: bit0 sectionEnabled, bit1 flipped, bit2 clipBox
          originHigh: vec4<f32>,
          originLow: vec4<f32>,
        }
        @binding(0) @group(0) var<uniform> uniforms: Uniforms;
        @binding(1) @group(0) var<storage, read> expressIds: array<u32>;
        @binding(2) @group(0) var<uniform> extraClip: ExtraClip;

        struct VertexInput {
          @location(0) position: vec3<f32>,
          @location(1) normal: vec3<f32>,
        }

        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
          @location(0) @interpolate(flat) objectId: u32,
          @location(1) worldPos: vec3<f32>,
        }

        @vertex
        fn vs_main(input: VertexInput, @builtin(instance_index) instanceIndex: u32) -> VertexOutput {
          var output: VertexOutput;
          let linear = (uniforms.model * vec4<f32>(input.position, 0.0)).xyz;
          let relative = rteWorldPosition(linear, RteDrawableUniform(uniforms.originHigh, uniforms.originLow)).xyz;
          output.position = uniforms.viewProj * vec4<f32>(relative, 1.0);
          output.worldPos = relative;
          // Look up expressId from storage buffer using instance index
          output.objectId = expressIds[instanceIndex];
          return output;
        }

        @fragment
        fn fs_main(input: VertexOutput) -> @location(0) u32 {
          // Mirror the main render's clip discards so a click can't select a
          // fragment the user has sectioned or cropped out of view.
          if ((uniforms.clipFlags.x & 1u) != 0u) {  // section plane enabled
            let flipped = (uniforms.clipFlags.x & 2u) != 0u;
            let side = select(1.0, -1.0, flipped);
            let distToPlane = (dot(input.worldPos, uniforms.sectionPlane.xyz) - uniforms.sectionPlane.w) * side;
            if (distToPlane > 0.0) {
              discard;
            }
          }
          if (extraClipClipped(extraClip, input.worldPos)) {  // cutting planes beyond the first (#7545)
            discard;
          }
          if ((uniforms.clipFlags.x & 4u) != 0u) {  // clip box enabled
            let p = input.worldPos;
            if (any(p < uniforms.clipBoxMin.xyz) || any(p > uniforms.clipBoxMax.xyz)) {
              discard;
            }
          }
          return input.objectId;
        }
      `;

/** Instanced occurrences: per-instance matrix, express id and flags in the instance buffer. */
export const instancedPickShaderWgsl = `
        ${relativeToEyeWgsl}
        ${extraClipWgsl}
        struct Uniforms {
          viewProj: mat4x4<f32>,
          clipBoxMin: vec4<f32>,   // xyz = min corner (world), w = pad
          clipBoxMax: vec4<f32>,   // xyz = max corner (world), w = pad
          sectionPlane: vec4<f32>, // xyz = plane normal, w = plane distance
          clipFlags: vec4<u32>,    // x: bit0 sectionEnabled, bit1 flipped, bit2 clipBox
          cameraHigh: vec4<f32>,
          cameraLow: vec4<f32>,
        }
        @binding(0) @group(0) var<uniform> uniforms: Uniforms;
        @binding(1) @group(0) var<uniform> extraClip: ExtraClip;
        struct VertexInput { @location(0) position: vec3<f32> }
        struct InstanceInput {
          @location(3) m0: vec4<f32>,
          @location(4) m1: vec4<f32>,
          @location(5) m2: vec4<f32>,
          @location(6) m3: vec4<f32>,
          @location(7) instEntityId: u32,
          @location(9) instFlags: u32,
          @location(10) anchorHigh: vec4<f32>,
          @location(11) anchorLow: vec4<f32>,
        }
        struct VertexOutput {
          @builtin(position) position: vec4<f32>,
          @location(0) @interpolate(flat) objectId: u32,
          @location(1) @interpolate(flat) instFlags: u32,
          @location(2) worldPos: vec3<f32>,
        }
        @vertex
        fn vs_main(input: VertexInput, inst: InstanceInput) -> VertexOutput {
          var output: VertexOutput;
          let m = mat4x4<f32>(inst.m0, inst.m1, inst.m2, inst.m3);
          let linear = (m * vec4<f32>(input.position, 0.0)).xyz;
          let relative = rteWorldPosition(linear, RteDrawableUniform(inst.anchorHigh, inst.anchorLow)).xyz;
          output.position = uniforms.viewProj * vec4<f32>(relative, 1.0);
          output.worldPos = relative;
          // bit 30 = instanced marker; express id in the low 30 bits.
          output.objectId = 0x40000000u | (inst.instEntityId & 0x3FFFFFFFu);
          output.instFlags = inst.instFlags;
          return output;
        }
        @fragment
        fn fs_main(input: VertexOutput) -> @location(0) u32 {
          // Hidden occurrences (flags bit 1) are not pickable — mirror the render-pass
          // discard so a hidden instanced element can't be selected through the picker.
          if ((input.instFlags & 2u) != 0u) {
            discard;
          }
          // Mirror the main render's section + crop-box discards for occurrences.
          if ((uniforms.clipFlags.x & 1u) != 0u) {  // section plane enabled
            let flipped = (uniforms.clipFlags.x & 2u) != 0u;
            let side = select(1.0, -1.0, flipped);
            let distToPlane = (dot(input.worldPos, uniforms.sectionPlane.xyz) - uniforms.sectionPlane.w) * side;
            if (distToPlane > 0.0) {
              discard;
            }
          }
          if (extraClipClipped(extraClip, input.worldPos)) {  // cutting planes beyond the first (#7545)
            discard;
          }
          if ((uniforms.clipFlags.x & 4u) != 0u) {  // clip box enabled
            let p = input.worldPos;
            if (any(p < uniforms.clipBoxMin.xyz) || any(p > uniforms.clipBoxMax.xyz)) {
              discard;
            }
          }
          return input.objectId;
        }
      `;
