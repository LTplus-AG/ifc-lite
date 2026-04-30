/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WGSL for the Phase-0 point cloud pipeline.
 *
 * Topology: point-list — every vertex is drawn as a single fragment.
 * Targets: same two attachments as the mesh pipeline (color + objectId)
 * so we can interleave point and triangle passes inside one render pass.
 *
 * Section-plane clipping mirrors main.wgsl.ts: when flags.y == 1, fragments
 * with `dot(plane.xyz, worldPos) > plane.w` are discarded.
 */
export const pointShaderSource = `
    struct PointUniforms {
      viewProj: mat4x4<f32>,
      model: mat4x4<f32>,
      colorOverride: vec4<f32>,       // .a > 0 means use this instead of per-vertex color
      pointSize: f32,
      _pad0: f32,
      _pad1: f32,
      _pad2: f32,
      sectionPlane: vec4<f32>,        // xyz = normal, w = plane distance
      flags: vec4<u32>,               // x = unused, y = sectionEnabled, z/w = unused
    }
    @binding(0) @group(0) var<uniform> uniforms: PointUniforms;

    struct VertexInput {
      @location(0) position: vec3<f32>,
      @location(1) color: vec4<f32>,
      @location(2) entityId: u32,
    }

    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) color: vec4<f32>,
      @location(1) worldPos: vec3<f32>,
      @location(2) @interpolate(flat) entityId: u32,
    }

    @vertex
    fn vs_main(input: VertexInput) -> VertexOutput {
      var output: VertexOutput;
      let worldPos4 = uniforms.model * vec4<f32>(input.position, 1.0);
      output.position = uniforms.viewProj * worldPos4;
      output.worldPos = worldPos4.xyz;
      let useOverride = uniforms.colorOverride.a > 0.5;
      output.color = select(input.color, uniforms.colorOverride, useOverride);
      output.entityId = input.entityId;
      return output;
    }

    struct FragmentOutput {
      @location(0) color: vec4<f32>,
      @location(1) objectId: vec4<f32>,
    }

    @fragment
    fn fs_main(input: VertexOutput) -> FragmentOutput {
      // Section-plane clipping
      if (uniforms.flags.y == 1u) {
        let d = dot(uniforms.sectionPlane.xyz, input.worldPos) - uniforms.sectionPlane.w;
        if (d > 0.0) {
          discard;
        }
      }

      var output: FragmentOutput;
      output.color = input.color;
      // Pack u32 entityId into rgba8 (least-significant byte → R, etc.)
      let id = input.entityId;
      output.objectId = vec4<f32>(
        f32((id >> 0u) & 0xffu) / 255.0,
        f32((id >> 8u) & 0xffu) / 255.0,
        f32((id >> 16u) & 0xffu) / 255.0,
        f32((id >> 24u) & 0xffu) / 255.0,
      );
      return output;
    }
`;
