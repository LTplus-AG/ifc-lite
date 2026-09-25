/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fragment stage for the selection/hover mask pass (#5390). The vertex
 * stage is `mainShaderSource`'s `vs_main` (recompiled as its own
 * `GPUShaderModule`, reusing the exact same RTE/section-plane/transform
 * math the selection highlight draw already uses) — this module supplies
 * only the fragment side, so the two can be mixed in one pipeline: a
 * fragment entry point with no declared inputs is interface-compatible
 * with any vertex stage, since `@builtin(position)` is always available.
 *
 * Manual depth test instead of a real depth-stencil attachment: comparing
 * `@builtin(position).z` (this fragment's own device depth) against the
 * scene depth texture (`depth-reconstruct.wgsl.ts`'s `loadDepth`, same
 * sample-0 convention as the AO/edge passes) means the mask targets stay
 * single-sample regardless of the scene's MSAA sample count, with no
 * resolve step of their own.
 *
 * Every output first drops fragments the section plane or clip box cuts
 * away (`sectionClipped`, shared with `fs_main`), so an outline never traces
 * geometry the section tool removed. That reads the mesh uniform at group 0
 * and the `worldPos` / `eyePos` varyings `vs_main` already emits.
 *
 * Three outputs, at most one per pipeline:
 *  - `fs_mask_selected_visible` / `fs_mask_hover_visible`: pass only where
 *    this fragment is at least as close as the stored scene depth
 *    (reverse-Z: `>=`), i.e. not occluded. `discard` otherwise, so the
 *    additive blend leaves the target at 0 there. The comparison is NOT
 *    exact: the stored depth is sample 0 of an MSAA attachment (not the
 *    pixel centre) and was usually written by the batch draw, whose
 *    positions may be quantized, so the same surface lands a slope-sized
 *    step away. `isVisible` therefore allows this fragment's own depth
 *    slope (`fwidth`, taken before any branch so it stays in uniform
 *    control flow) plus `MASK_DEPTH_REL_TOLERANCE` of its depth; reverse-Z
 *    depth is proportional to 1/distance, so that is a relative distance
 *    tolerance. A fixed 1e-7 epsilon failed on every pixel of a real
 *    WebGPU frame, leaving the visible mask empty.
 *  - `fs_mask_selected_all`: always passes (drawn "through occluders").
 */
import { depthTextureWgsl } from './depth-reconstruct.wgsl.js';
import { meshUniformsWgsl } from './mesh-uniforms.wgsl.js';

/**
 * Bind-group index of the scene depth texture in the mask pipeline layout:
 * group 0 is the mesh uniform that `vs_main` reads, so depth is group 1.
 * `selection-mask-pass.ts` builds its layout from this same constant.
 */
export const SELECTION_MASK_DEPTH_GROUP = 1;

/** Relative depth slack for "the same surface" (reverse-Z: ~0.2 % of the distance). */
export const MASK_DEPTH_REL_TOLERANCE = 2e-3;

export function selectionMaskFragmentSource(multisampled: boolean): string {
  return `
        ${meshUniformsWgsl}
        ${depthTextureWgsl(0, multisampled, SELECTION_MASK_DEPTH_GROUP)}

        // The subset of vs_main's VertexOutput the mask reads (locations match).
        struct MaskInput {
          @builtin(position) fragPos: vec4<f32>,
          @location(0) worldPos: vec3<f32>,
          @location(6) eyePos: vec3<f32>,
        }

        fn isCut(input: MaskInput) -> bool {
          return sectionClipped(clipSpacePos(input.worldPos, input.eyePos));
        }

        const MASK_DEPTH_REL_TOLERANCE: f32 = ${MASK_DEPTH_REL_TOLERANCE};

        // depthSlope = fwidth(fragPos.z), taken by the caller in uniform control flow.
        fn isVisible(fragPos: vec4<f32>, depthSlope: f32) -> bool {
          let ip = vec2<i32>(fragPos.xy);
          let slack = depthSlope + fragPos.z * MASK_DEPTH_REL_TOLERANCE;
          return fragPos.z >= loadDepth(ip) - slack;
        }

        @fragment
        fn fs_mask_selected_visible(input: MaskInput) -> @location(0) vec4<f32> {
          let depthSlope = fwidth(input.fragPos.z);
          if (isCut(input) || !isVisible(input.fragPos, depthSlope)) { discard; }
          return vec4<f32>(1.0, 0.0, 0.0, 0.0);
        }

        @fragment
        fn fs_mask_hover_visible(input: MaskInput) -> @location(0) vec4<f32> {
          let depthSlope = fwidth(input.fragPos.z);
          if (isCut(input) || !isVisible(input.fragPos, depthSlope)) { discard; }
          return vec4<f32>(0.0, 1.0, 0.0, 0.0);
        }

        @fragment
        fn fs_mask_selected_all(input: MaskInput) -> @location(0) vec4<f32> {
          if (isCut(input)) { discard; }
          return vec4<f32>(1.0, 0.0, 0.0, 0.0);
        }
`;
}
