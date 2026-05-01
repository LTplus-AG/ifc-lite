/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WGSL for the point cloud splat pipeline.
 *
 * Draws each point as an instanced quad (6 verts per point, triangle-list
 * topology) so we can give it a real on-screen size — `point-list` has
 * no `gl_PointSize` equivalent in WebGPU, which is why a 1-px point cloud
 * looks like a halftone screen as you zoom in.
 *
 * Three size modes (uniforms.sizing.x):
 *   0 = fixed-px         — every point renders at `pointSizePx` pixels
 *   1 = adaptive-world   — splat covers `worldRadius` metres, projected
 *   2 = attenuated       — adaptive but clamped to [1, pointSizePx] px
 *
 * Color modes (uniforms.colorModeAndExtras.x):
 *   0 = per-vertex RGB,  1 = classification,  2 = intensity ramp,
 *   3 = height ramp,     4 = fixed override.
 *
 * Round shape: fragment discards corners outside the unit disc, so
 * splats render as circles (not squares) at any size > ~3 px.
 */
export const pointShaderSource = `
    struct PointUniforms {
      viewProj: mat4x4<f32>,
      model: mat4x4<f32>,
      colorOverride: vec4<f32>,
      // x = colorMode, y = pointSizePx, z = heightMin, w = heightMax
      colorModeAndExtras: vec4<f32>,
      // x = sizeMode, y = worldRadius (m), z = viewportWidth, w = viewportHeight
      sizing: vec4<f32>,
      sectionPlane: vec4<f32>,
      // x = assetExpressId (federation-aware globalId), y = sectionEnabled,
      // z = roundShape, w = unused
      flags: vec4<u32>,
      // x = previewStride (1 = render every point, N = render every
      // Nth instance — used by the section-plane drag preview path).
      // yzw reserved for future per-frame state.
      extras: vec4<u32>,
    }
    @binding(0) @group(0) var<uniform> uniforms: PointUniforms;

    struct VertexInput {
      @location(0) position: vec3<f32>,
      @location(1) rgbAndClass: vec4<f32>,   // unorm8x4 → 0..1 each
      @location(2) intensityPacked: u32,     // low 16 bits = intensity
      @location(3) entityId: u32,
    }

    struct VertexOutput {
      @builtin(position) position: vec4<f32>,
      @location(0) color: vec4<f32>,
      @location(1) worldPos: vec3<f32>,
      @location(2) @interpolate(flat) entityId: u32,
      @location(3) quadUv: vec2<f32>,
    }

    fn classification_color(class_id: u32) -> vec3<f32> {
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
    fn vs_main(
      input: VertexInput,
      @builtin(vertex_index) vId: u32,
      @builtin(instance_index) iId: u32,
    ) -> VertexOutput {
      // Preview-density stride cull. UI sets extras.x to e.g. 4
      // while the user drags a section-plane slider so we render
      // every 4th point and the drag stays responsive on huge scans.
      // stride <= 1 is the no-op default.
      let stride = max(1u, uniforms.extras.x);
      if (stride > 1u && (iId % stride) != 0u) {
        var skipped: VertexOutput;
        // Push behind the near plane so the rasteriser drops it.
        skipped.position = vec4<f32>(0.0, 0.0, -2.0, 1.0);
        skipped.color = vec4<f32>(0.0);
        skipped.worldPos = vec3<f32>(0.0);
        skipped.entityId = 0u;
        skipped.quadUv = vec2<f32>(0.0);
        return skipped;
      }

      // Quad corners (two triangles, CCW) in unit disc coords:
      //   tri 1: (-1,-1)(1,-1)(1,1)
      //   tri 2: (-1,-1)(1, 1)(-1,1)
      var corners = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 1.0, -1.0),
        vec2<f32>( 1.0,  1.0),
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 1.0,  1.0),
        vec2<f32>(-1.0,  1.0),
      );
      let corner = corners[vId];

      let worldPos4 = uniforms.model * vec4<f32>(input.position, 1.0);
      var clipPos = uniforms.viewProj * worldPos4;

      // Compute splat half-extent in pixels for the active size mode.
      let sizeMode = u32(uniforms.sizing.x);
      let worldRadius = uniforms.sizing.y;
      let viewport = uniforms.sizing.zw;
      let pointSizePx = uniforms.colorModeAndExtras.y;

      // halfPx is the splat RADIUS in pixels. The user-facing
      // pointSizePx is the diameter ("8 px point"), so divide by 2
      // when feeding it to the pipeline. Without this the fixed and
      // attenuated branches render splats at ~2x their requested size.
      var halfPx: f32;
      if (sizeMode == 0u) {
        halfPx = max(0.5, pointSizePx * 0.5);
      } else {
        // Project a world-radius offset to clip space, take pixel delta.
        // worldRadius is already a radius — no /2 needed here.
        let edgePos = uniforms.viewProj * (worldPos4 + vec4<f32>(worldRadius, 0.0, 0.0, 0.0));
        let centerNdcX = clipPos.x / max(abs(clipPos.w), 1e-6);
        let edgeNdcX = edgePos.x / max(abs(edgePos.w), 1e-6);
        let projectedPx = abs(edgeNdcX - centerNdcX) * 0.5 * viewport.x;
        if (sizeMode == 2u) {
          halfPx = clamp(projectedPx, 0.5, max(0.5, pointSizePx * 0.5));
        } else {
          halfPx = max(0.5, projectedPx);
        }
      }

      // Convert pixel offset to clip-space offset. Multiply by clipPos.w
      // because the GPU divides by w during the perspective divide.
      let halfClip = vec2<f32>(halfPx) / max(viewport, vec2<f32>(1.0)) * 2.0 * abs(clipPos.w);
      clipPos.x = clipPos.x + corner.x * halfClip.x;
      clipPos.y = clipPos.y + corner.y * halfClip.y;

      // Color selection
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

      var output: VertexOutput;
      output.position = clipPos;
      output.color = vec4<f32>(rgb, 1.0);
      output.worldPos = worldPos4.xyz;
      output.entityId = input.entityId;
      output.quadUv = corner;
      return output;
    }

    struct FragmentOutput {
      @location(0) color: vec4<f32>,
      @location(1) objectId: vec4<f32>,
    }

    @fragment
    fn fs_main(input: VertexOutput) -> FragmentOutput {
      // Round shape — discard corners outside the unit disc.
      if (uniforms.flags.z == 1u) {
        if (dot(input.quadUv, input.quadUv) > 1.0) {
          discard;
        }
      }

      // Section-plane clipping
      if (uniforms.flags.y == 1u) {
        let d = dot(uniforms.sectionPlane.xyz, input.worldPos) - uniforms.sectionPlane.w;
        if (d > 0.0) {
          discard;
        }
      }

      var output: FragmentOutput;
      output.color = input.color;
      // Prefer the asset-level expressId from the uniform when it's set
      // (federation needs to relabel post-stream, so we can't rely on
      // the per-vertex attribute that was baked at upload time).
      // flags.x == 0 → fall back to per-vertex value to preserve the
      // legacy contract during the upload-only rendering window.
      let id = select(input.entityId, uniforms.flags.x, uniforms.flags.x != 0u);
      output.objectId = vec4<f32>(
        f32((id >> 0u) & 0xffu) / 255.0,
        f32((id >> 8u) & 0xffu) / 255.0,
        f32((id >> 16u) & 0xffu) / 255.0,
        f32((id >> 24u) & 0xffu) / 255.0,
      );
      return output;
    }
`;
