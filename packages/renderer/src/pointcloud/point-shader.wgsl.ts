/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WGSL for the point cloud pipeline.
 *
 * Topology: point-list — every vertex is drawn as a single fragment.
 * Targets: same two attachments as the mesh pipeline (color + objectId)
 * so we can interleave point and triangle passes inside one render pass.
 *
 * Color modes (uniforms.colorModeAndPad.x):
 *   0 = per-vertex RGB (default)
 *   1 = classification → palette
 *   2 = intensity (gray ramp)
 *   3 = height ramp (Y in world space → palette)
 *   4 = fixed override (uniforms.colorOverride)
 */
export const pointShaderSource = `
    struct PointUniforms {
      viewProj: mat4x4<f32>,
      model: mat4x4<f32>,
      colorOverride: vec4<f32>,
      // x = colorMode, y = pointSize, z = heightMin (Y-up world), w = heightMax
      colorModeAndExtras: vec4<f32>,
      sectionPlane: vec4<f32>,
      // x = unused, y = sectionEnabled, z = unused, w = unused
      flags: vec4<u32>,
    }
    @binding(0) @group(0) var<uniform> uniforms: PointUniforms;

    struct VertexInput {
      @location(0) position: vec3<f32>,
      @location(1) rgbAndClass: vec4<f32>,   // unorm8x4 → 0..1 each
      @location(2) intensityPacked: u32,     // low 16 bits = intensity, high 16 = pad
      @location(3) entityId: u32,
    }

    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) color: vec4<f32>,
      @location(1) worldPos: vec3<f32>,
      @location(2) @interpolate(flat) entityId: u32,
    }

    // Standard ASPRS classification palette (LAS spec). Indices we don't
    // care about render gray — caller can override per-deployment via the
    // fixed colorOverride mode if a custom mapping is needed.
    fn classification_color(class_id: u32) -> vec3<f32> {
      // 0 created/never classified → light gray
      // 1 unclassified            → gray
      // 2 ground                  → brown
      // 3 low vegetation          → light green
      // 4 medium vegetation       → green
      // 5 high vegetation         → dark green
      // 6 building                → orange
      // 7 noise                   → red
      // 8 model key               → cyan
      // 9 water                   → blue
      // 10 rail                   → purple
      // 11 road surface           → dark gray
      // 12 reserved               → magenta
      // 13 wire-guard             → yellow
      // 14 wire-conductor         → light yellow
      // 15 transmission tower     → dark blue
      // 16 wire connector         → teal
      // 17 bridge deck            → tan
      // 18 high noise             → red
      switch (class_id) {
        case 0u, 1u: { return vec3<f32>(0.65, 0.65, 0.65); }
        case 2u:     { return vec3<f32>(0.55, 0.40, 0.25); }
        case 3u:     { return vec3<f32>(0.55, 0.85, 0.45); }
        case 4u:     { return vec3<f32>(0.30, 0.75, 0.30); }
        case 5u:     { return vec3<f32>(0.10, 0.45, 0.15); }
        case 6u:     { return vec3<f32>(0.95, 0.55, 0.20); }
        case 7u:     { return vec3<f32>(0.95, 0.20, 0.20); }
        case 8u:     { return vec3<f32>(0.20, 0.85, 0.95); }
        case 9u:     { return vec3<f32>(0.20, 0.40, 0.95); }
        case 10u:    { return vec3<f32>(0.55, 0.20, 0.85); }
        case 11u:    { return vec3<f32>(0.30, 0.30, 0.30); }
        case 13u:    { return vec3<f32>(0.95, 0.85, 0.20); }
        case 14u:    { return vec3<f32>(0.95, 0.95, 0.50); }
        case 15u:    { return vec3<f32>(0.20, 0.20, 0.55); }
        case 16u:    { return vec3<f32>(0.30, 0.65, 0.65); }
        case 17u:    { return vec3<f32>(0.85, 0.70, 0.50); }
        case 18u:    { return vec3<f32>(0.95, 0.20, 0.20); }
        default:     { return vec3<f32>(0.65, 0.65, 0.65); }
      }
    }

    fn height_ramp(t: f32) -> vec3<f32> {
      // Cool → warm: blue → cyan → green → yellow → red.
      let s = clamp(t, 0.0, 1.0);
      if (s < 0.25) {
        let k = s / 0.25;
        return mix(vec3<f32>(0.10, 0.20, 0.85), vec3<f32>(0.10, 0.85, 0.85), k);
      } else if (s < 0.5) {
        let k = (s - 0.25) / 0.25;
        return mix(vec3<f32>(0.10, 0.85, 0.85), vec3<f32>(0.20, 0.85, 0.20), k);
      } else if (s < 0.75) {
        let k = (s - 0.5) / 0.25;
        return mix(vec3<f32>(0.20, 0.85, 0.20), vec3<f32>(0.95, 0.95, 0.20), k);
      } else {
        let k = (s - 0.75) / 0.25;
        return mix(vec3<f32>(0.95, 0.95, 0.20), vec3<f32>(0.95, 0.20, 0.10), k);
      }
    }

    @vertex
    fn vs_main(input: VertexInput) -> VertexOutput {
      var output: VertexOutput;
      let worldPos4 = uniforms.model * vec4<f32>(input.position, 1.0);
      output.position = uniforms.viewProj * worldPos4;
      output.worldPos = worldPos4.xyz;

      let mode = u32(uniforms.colorModeAndExtras.x);
      let intensity01 = f32(input.intensityPacked & 0xffffu) / 65535.0;
      let classId = u32(round(input.rgbAndClass.a * 255.0));
      let heightT =
        (worldPos4.y - uniforms.colorModeAndExtras.z) /
        max(1e-6, uniforms.colorModeAndExtras.w - uniforms.colorModeAndExtras.z);

      var rgb: vec3<f32>;
      switch (mode) {
        case 0u: { rgb = input.rgbAndClass.rgb; }
        case 1u: { rgb = classification_color(classId); }
        case 2u: { rgb = vec3<f32>(intensity01, intensity01, intensity01); }
        case 3u: { rgb = height_ramp(heightT); }
        case 4u: { rgb = uniforms.colorOverride.rgb; }
        default: { rgb = input.rgbAndClass.rgb; }
      }
      output.color = vec4<f32>(rgb, 1.0);
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
