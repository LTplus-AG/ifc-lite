/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WGSL shaders for the IfcAnnotation overlay (fills + text labels).
 *
 * Two pipelines share this file because they ride the same camera uniform
 * layout and write into the same RGBA-blended pass. Splitting per-pipeline
 * would mean two near-identical vertex inputs and duplicate camera structs.
 */

export const SYMBOLIC_FILL_WGSL = /* wgsl */ `
struct Camera {
  viewProj: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;

struct VsIn {
  @location(0) position: vec3<f32>,
  @location(1) color:    vec4<f32>,
};

struct VsOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0)        color:  vec4<f32>,
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
  var out: VsOut;
  out.clipPos = camera.viewProj * vec4<f32>(in.position, 1.0);
  out.color   = in.color;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  // Premultiply alpha so the standard "src * 1 + dst * (1-src.a)" blend
  // produces the correct composite on top of the existing scene.
  return vec4<f32>(in.color.rgb * in.color.a, in.color.a);
}
`;

export const SYMBOLIC_TEXT_WGSL = /* wgsl */ `
struct Camera {
  viewProj: mat4x4<f32>,
  // x = viewport width in physical pixels, y = viewport height
  // z = target glyph cap-height in screen pixels, w = padding
  viewportAndTarget: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var atlasTex: texture_2d<f32>;
@group(0) @binding(2) var atlasSamp: sampler;

// Per-vertex (corner of the glyph quad).
struct VsIn {
  // Bit-packed corner index 0..3. The vertex buffer is just [0u, 1u, 2u, 3u].
  @location(0) corner: u32,
};

// Per-instance attributes — one record per glyph.
struct InstIn {
  // World-space origin of the glyph (bottom-left, after alignment + rotation).
  @location(1) origin: vec3<f32>,
  // Right axis in world space — encodes both glyph width and baseline rotation.
  @location(2) rightAxis: vec3<f32>,
  // Up axis in world space — encodes glyph height and baseline rotation.
  @location(3) upAxis: vec3<f32>,
  // Atlas UV bounds: (u0, v0, u1, v1).
  @location(4) uvBounds: vec4<f32>,
  // Glyph tint (sRGB straight-alpha).
  @location(5) color: vec4<f32>,
  // Shared text-label anchor (every glyph in the same label uses the same
  // anchor). Lets the shader compute one screen-space scale per label and
  // apply it uniformly to every glyph offset so row spacing stays in sync.
  @location(6) anchor: vec3<f32>,
  // Authored cap height in world units. Same value for every glyph in the
  // label; used to convert "target pixels" into a scale factor.
  @location(7) capHeight: f32,
};

struct VsOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv:    vec2<f32>,
  @location(1) color: vec4<f32>,
};

@vertex
fn vs_main(in: VsIn, inst: InstIn) -> VsOut {
  // Map corner index to (u, v) in [0, 1] — the four quad corners.
  //   0 = bottom-left, 1 = bottom-right, 2 = top-left, 3 = top-right.
  let u = f32((in.corner & 1u));      // 0,1,0,1
  let v = f32((in.corner >> 1u) & 1u); // 0,0,1,1

  // ── Screen-space text scaling ──
  // Project the label's shared anchor. For a standard perspective projection
  // clip.w ≈ view-space depth, and 1 NDC unit corresponds to viewportH/2
  // pixels — so "world per pixel" at this depth ≈ (2*w)/viewportH.
  let anchorClip = camera.viewProj * vec4<f32>(inst.anchor, 1.0);
  let absW = max(abs(anchorClip.w), 1e-4);
  let worldPerPixel = (2.0 * absW) / max(camera.viewportAndTarget.y, 1.0);
  let safeCap = max(inst.capHeight, 1e-4);
  // wanted_world = target_pixels * world_per_pixel; scale = wanted/authored.
  let scale = (camera.viewportAndTarget.z * worldPerPixel) / safeCap;

  // Apply the single scale to (origin − anchor), rightAxis, and upAxis so
  // per-glyph spacing and glyph dimensions track each other.
  let localOffset = inst.origin - inst.anchor;
  let worldPos = inst.anchor
               + localOffset    * scale
               + inst.rightAxis * scale * u
               + inst.upAxis    * scale * v;

  // UV: lerp atlas bounds. Note v inverted (atlas top is v=0).
  let uMix = mix(inst.uvBounds.x, inst.uvBounds.z, u);
  let vMix = mix(inst.uvBounds.w, inst.uvBounds.y, v);

  var out: VsOut;
  out.clipPos = camera.viewProj * vec4<f32>(worldPos, 1.0);
  out.uv      = vec2<f32>(uMix, vMix);
  out.color   = inst.color;
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let atlas = textureSample(atlasTex, atlasSamp, in.uv);
  // The atlas was rasterised with white glyphs on a transparent background,
  // so atlas.r is the coverage and atlas.a is the alpha. Multiply by the
  // per-glyph tint and premultiply for the standard composite.
  let alpha = atlas.a * in.color.a;
  return vec4<f32>(in.color.rgb * alpha, alpha);
}
`;
