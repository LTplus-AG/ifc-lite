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
  // Screen-aligned camera basis (world space). xyz = direction, w = padding.
  // Used by billboarded glyphs (grid tags) so they always face the camera —
  // critical for top-down/ground views where world-up upAxis collapses to
  // zero screen extent and the tag becomes invisible.
  cameraRight: vec4<f32>,
  cameraUp:    vec4<f32>,
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
  // Billboard flag (1.0 = use camera-aligned axes, 0.0 = use authored
  // rightAxis/upAxis). Only the grid-tag emission path sets this to 1.0.
  @location(8) billboard: f32,
  // Per-glyph baseline-relative offset + size in WORLD units. Only used
  // when billboard=1 (the authored origin bakes the offset along the
  // floor-plane basis, which is the wrong direction for camera-aligned
  // text). For non-billboard glyphs these are written too but the shader
  // picks the authored path. World units = atlas-pixel * wScale.
  //   .xy = (offsetX, offsetY) from anchor to glyph BL
  //   .zw = (width, height) of the glyph quad
  @location(9) glyphOffsetSize: vec4<f32>,
  // Per-instance target cap height in screen pixels. 0 = fall back to
  // the renderer global default (viewportAndTarget.z). Grid bubble
  // glyphs override with a larger value so the bubble stays proportional
  // to the tag at every zoom level.
  @location(10) targetPxOverride: f32,
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

  // ── Screen-space text scaling (projection-agnostic) ──
  // For non-billboard glyphs measure world-Y → screen pixels (matches the
  // authored upAxis convention). For billboard glyphs measure cameraUp →
  // screen pixels — that axis ALWAYS spans the full viewport height
  // regardless of view angle, so screen-space scaling stays correct in
  // top-down / ground / oblique views.
  let isBillboard = inst.billboard > 0.5;
  let scaleProbeAxis = select(vec3<f32>(0.0, 1.0, 0.0), camera.cameraUp.xyz, isBillboard);
  let aClip = camera.viewProj * vec4<f32>(inst.anchor, 1.0);
  let bClip = camera.viewProj * vec4<f32>(inst.anchor + scaleProbeAxis, 1.0);
  let aNdc = aClip.xy / max(abs(aClip.w), 1e-4);
  let bNdc = bClip.xy / max(abs(bClip.w), 1e-4);
  let unitYPx = length(bNdc - aNdc) * camera.viewportAndTarget.y * 0.5;

  let safeCap = max(inst.capHeight, 1e-4);
  let currentPx = safeCap * unitYPx;
  // Per-instance target overrides the uniform default (used by grid bubble
  // glyphs to render at a larger on-screen size than the inscribed tag).
  let targetPx = select(camera.viewportAndTarget.z, inst.targetPxOverride, inst.targetPxOverride > 0.0);
  // Clamp to (0.02, 1.0]: never grow text beyond authored size; never
  // shrink below ~2%.
  let scale = clamp(
    targetPx / max(currentPx, 1e-2),
    0.02,
    1.0,
  );

  // ── Position the glyph quad in world space ──
  // Non-billboard: authored axes (text lies in the floor plane of its
  // annotation — IFC convention). Billboard: camera-aligned axes (text
  // always faces the camera — grid-tag convention).
  let authoredLocalOffset = inst.origin - inst.anchor;
  let authoredWorldPos =
      inst.anchor
    + authoredLocalOffset * scale
    + inst.rightAxis * scale * u
    + inst.upAxis    * scale * v;

  // Billboard: rebuild the quad in screen-aligned camera basis. glyphOffsetSize
  // carries the same 2D atlas-pixel layout the upload computed, just in
  // world units — re-project onto (cameraRight, cameraUp) so it tracks the
  // viewer's eye in every orientation.
  let bbOffsetX = inst.glyphOffsetSize.x;
  let bbOffsetY = inst.glyphOffsetSize.y;
  let bbWidth   = inst.glyphOffsetSize.z;
  let bbHeight  = inst.glyphOffsetSize.w;
  let billboardWorldPos =
      inst.anchor
    + (camera.cameraRight.xyz * bbOffsetX + camera.cameraUp.xyz * bbOffsetY) * scale
    + (camera.cameraRight.xyz * bbWidth   * u
     + camera.cameraUp.xyz    * bbHeight  * v) * scale;

  let worldPos = select(authoredWorldPos, billboardWorldPos, isBillboard);

  // UV: lerp atlas bounds. Note v inverted (atlas top is v=0).
  let uMix = mix(inst.uvBounds.x, inst.uvBounds.z, u);
  let vMix = mix(inst.uvBounds.w, inst.uvBounds.y, v);

  var out: VsOut;
  let clip = camera.viewProj * vec4<f32>(worldPos, 1.0);
  // Reverse-Z decal nudge for text coplanar with model faces (issue #812
  // follow-up: "30", "1.49" etc. flickering against the terrain). The
  // pipeline-level depthBiasSlopeScale collapses to ~0 for billboard
  // glyphs — the quad faces the camera, so depth slope across the quad
  // is zero — leaving only a tiny -4 constant that MSAA jitter beats.
  // Adding a small positive multiple of clip.w raises NDC z by a
  // constant after the w-divide, which under reverse-Z reads as
  // "slightly closer" — same trick the line pipeline uses.
  out.clipPos = vec4<f32>(clip.x, clip.y, clip.z + 5e-5 * clip.w, clip.w);
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
