/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared WGSL half of the renderer RTE contract.
 *
 * A pass owns its binding declarations, but imports this verbatim into its
 * shader source and uses `rteWorldPosition` before projection.  The layouts
 * match `RelativeToEyeFrame.packUniforms` and `packRteOrigin` exactly:
 * `viewProj` + two vec4 camera lanes per frame, then two vec4 drawable lanes
 * per draw.  Origins are world/source f64 values split on the CPU; `local` is
 * the element-local f32 vertex already resident in a vertex buffer.
 */
export const relativeToEyeWgsl = `
struct RteFrameUniform {
  // Camera translation is intentionally absent.  This consumes positions
  // returned by rteWorldPosition, which are already relative to the eye.
  viewProj: mat4x4<f32>,
  cameraHigh: vec4<f32>,
  cameraLow: vec4<f32>,
}

struct RteDrawableUniform {
  drawableHigh: vec4<f32>,
  drawableLow: vec4<f32>,
}

fn rteWorldPosition(
  local: vec3<f32>,
  frame: RteFrameUniform,
  drawable: RteDrawableUniform,
) -> vec4<f32> {
  // Keep the two cancellation stages separate.  Re-associating this as
  // (drawableHigh + drawableLow) - (cameraHigh + cameraLow) recreates the
  // large-coordinate loss RTE is meant to prevent.
  let highDelta = drawable.drawableHigh.xyz - frame.cameraHigh.xyz;
  let lowDelta = drawable.drawableLow.xyz - frame.cameraLow.xyz;
  return vec4<f32>(local + (highDelta + lowDelta), 1.0);
}
`;
