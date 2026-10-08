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
 * Visible masks share the scene's MSAA sample count and read-only depth
 * attachment. Hardware greater-equal testing compares the same raster sample,
 * without treating neighbouring or genuinely occluded surfaces as coincident.
 * The mask pass resolves coverage after its selected and hovered draws.
 *
 * Every output first drops fragments the section plane or clip box cuts
 * away (`sectionClipped`, shared with `fs_main`), so an outline never traces
 * geometry the section tool removed. That reads the mesh uniform at group 0
 * and the `worldPos` / `eyePos` varyings `vs_main` already emits.
 *
 * Three outputs, at most one per pipeline:
 *  - `fs_mask_selected_visible` / `fs_mask_hover_visible`: pass only where
 *    this fragment is at least as close as the stored scene depth
 *    (reverse-Z: greater-equal), using the scene depth attachment.
 *  - `fs_mask_selected_all`: always passes (drawn "through occluders").
 *
 * Instanced variant (#5745, `instanced = true`): the vertex stage is
 * `vs_instanced` instead, so one draw covers every occurrence of a template.
 * The same entry points then also keep only the occurrences they are for:
 * selected ones (instance flag bit 0) for the selected outputs, and the one
 * whose entity id is the hovered id (a small uniform at
 * `SELECTION_MASK_HOVER_GROUP`) for the hover output. Hidden occurrences
 * (flag bit 1) are dropped, as `fs_main` drops them. The section/clip cut and
 * the depth test are the same code as the non-instanced variant.
 */
import { meshUniformsWgsl } from './mesh-uniforms.wgsl.js';

/**
 * Bind-group index of the hovered-entity uniform (`vec4<u32>`, x = id) in the
 * INSTANCED mask pipeline layout only (#5745). The non-instanced variant
 * selects its meshes on the CPU and declares no such binding.
 */
export const SELECTION_MASK_HOVER_GROUP = 1;

/**
 * Which occurrences each output keeps. The non-instanced pass is handed only
 * the meshes it should draw, so every fragment qualifies; the instanced pass
 * draws whole templates and filters per occurrence off the flat varyings
 * `vs_instanced` emits (`VertexOutput.entityId` / `.instSelected`).
 */
function occurrenceFilterWgsl(instanced: boolean): string {
  if (!instanced) {
    return `
        fn isSelectedOccurrence(input: MaskInput) -> bool { return true; }
        fn isHoveredOccurrence(input: MaskInput) -> bool { return true; }`;
  }
  return `
        @group(${SELECTION_MASK_HOVER_GROUP}) @binding(0) var<uniform> maskHover: vec4<u32>;
        // bit 0 = selected, bit 1 = hidden (instanced-vertex-layout.ts).
        fn isSelectedOccurrence(input: MaskInput) -> bool { return (input.instSelected & 3u) == 1u; }
        fn isHoveredOccurrence(input: MaskInput) -> bool {
          return (input.instSelected & 2u) == 0u && input.entityId == maskHover.x;
        }`;
}

export function selectionMaskFragmentSource(instanced = false): string {
  const instanceVaryings = instanced
    ? `
          @location(2) @interpolate(flat) entityId: u32,
          @location(5) @interpolate(flat) instSelected: u32,`
    : '';
  return `
        ${meshUniformsWgsl}

        // The subset of the vertex stage's VertexOutput the mask reads (locations match).
        struct MaskInput {
          @builtin(position) fragPos: vec4<f32>,
          @location(0) worldPos: vec3<f32>,
          @location(6) eyePos: vec3<f32>,${instanceVaryings}
        }
        ${occurrenceFilterWgsl(instanced)}

        fn isCut(input: MaskInput) -> bool {
          return sectionClipped(clipSpacePos(input.worldPos, input.eyePos));
        }

        @fragment
        fn fs_mask_selected_visible(input: MaskInput) -> @location(0) vec4<f32> {
          if (!isSelectedOccurrence(input) || isCut(input)) { discard; }
          return vec4<f32>(1.0, 0.0, 0.0, 0.0);
        }

        @fragment
        fn fs_mask_hover_visible(input: MaskInput) -> @location(0) vec4<f32> {
          if (!isHoveredOccurrence(input) || isCut(input)) { discard; }
          return vec4<f32>(0.0, 1.0, 0.0, 0.0);
        }

        @fragment
        fn fs_mask_selected_all(input: MaskInput) -> @location(0) vec4<f32> {
          if (!isSelectedOccurrence(input) || isCut(input)) { discard; }
          return vec4<f32>(1.0, 0.0, 0.0, 0.0);
        }
`;
}
