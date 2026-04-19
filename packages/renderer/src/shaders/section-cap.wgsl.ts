/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section cap shaders
 *
 * Three shader modules that cooperate to render filled, hatched cut surfaces
 * using the classic stencil-buffer capping technique:
 *
 *   1. stencilGeomShaderSource — minimal vertex + fragment stub that runs the
 *      geometry twice (once per face-cull mode). It discards fragments above
 *      the plane and writes nothing to colour/depth. The pipeline's stencil
 *      state (inc on back, dec on front) is the only output.
 *
 *   2. capFillShaderSource — a full-screen quad that reads the stencil buffer
 *      and, where stencil != 0, paints the cap with a screen-space hatch
 *      pattern chosen from a small LUT.
 */

// ─── Stencil geometry pass ────────────────────────────────────────────────

export const stencilGeomShaderSource = /* wgsl */ `
struct Uniforms {
  viewProj:     mat4x4<f32>,
  sectionPlane: vec4<f32>,   // xyz = plane normal (world space), w = plane distance
  flags:        vec4<u32>,   // x = flipped (0/1), y,z,w reserved
}
@binding(0) @group(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal:   vec3<f32>,
  @location(2) entityId: u32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0)       worldPos: vec3<f32>,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  // Batched meshes are already in world space (identity model matrix).
  out.worldPos = input.position;
  out.position = uniforms.viewProj * vec4<f32>(input.position, 1.0);
  return out;
}

@fragment
fn fs_main(in: VertexOutput) {
  // flipped flag negates the "kept" side so the user can cut either half.
  let sign = select(1.0, -1.0, uniforms.flags.x == 1u);
  let d = (dot(in.worldPos, uniforms.sectionPlane.xyz) - uniforms.sectionPlane.w) * sign;
  if (d <= 0.0) {
    // Below the plane: do not contribute to the stencil count. Stencil ops
    // are set to 'keep' when the fragment fails this early-out via discard.
    discard;
  }
  // Otherwise: fragment passes, stencil op runs (inc on back pass, dec on front).
}
`;

// ─── Instanced variant (for the instancing pipeline) ──────────────────────

export const stencilGeomInstancedShaderSource = /* wgsl */ `
struct Instance {
  transform: mat4x4<f32>,
  color:     vec4<f32>,
}

struct Uniforms {
  viewProj:     mat4x4<f32>,
  sectionPlane: vec4<f32>,
  flags:        vec4<u32>,
}
@binding(0) @group(0) var<uniform> uniforms: Uniforms;
@binding(1) @group(0) var<storage, read> instances: array<Instance>;

// Z-up to Y-up conversion, matching the main instanced pipeline.
const zToYUp = mat4x4<f32>(
  vec4<f32>(1.0, 0.0,  0.0, 0.0),
  vec4<f32>(0.0, 0.0, -1.0, 0.0),
  vec4<f32>(0.0, 1.0,  0.0, 0.0),
  vec4<f32>(0.0, 0.0,  0.0, 1.0)
);

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal:   vec3<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0)       worldPos: vec3<f32>,
}

@vertex
fn vs_main(input: VertexInput, @builtin(instance_index) idx: u32) -> VertexOutput {
  var out: VertexOutput;
  let worldZUp = instances[idx].transform * vec4<f32>(input.position, 1.0);
  let worldY   = zToYUp * worldZUp;
  out.worldPos = worldY.xyz;
  out.position = uniforms.viewProj * worldY;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) {
  let sign = select(1.0, -1.0, uniforms.flags.x == 1u);
  let d = (dot(in.worldPos, uniforms.sectionPlane.xyz) - uniforms.sectionPlane.w) * sign;
  if (d <= 0.0) {
    discard;
  }
}
`;

// ─── Cap fill (full-screen quad) ──────────────────────────────────────────

/**
 * Hatch pattern IDs — keep in sync with HATCH_PATTERN_IDS in section-cap.ts.
 *   0 = solid fill (no pattern)
 *   1 = diagonal lines
 *   2 = cross-hatch
 *   3 = horizontal lines
 *   4 = vertical lines
 *   5 = concrete (dots + short diagonals)
 *   6 = brick (offset horizontal segments)
 *   7 = insulation (wave)
 */
export const capFillShaderSource = /* wgsl */ `
struct CapUniforms {
  // Fill colour (background of the cap).
  fillColor:    vec4<f32>,
  // Stroke colour used by the hatch pattern.
  strokeColor:  vec4<f32>,
  // x = pattern id (u32 stored as f32), y = spacing in px, z = angle (radians),
  // w = line width in px.
  params:       vec4<f32>,
  // x = secondary angle (cross-hatch), y,z,w reserved.
  params2:      vec4<f32>,
}

@binding(0) @group(0) var<uniform> cap: CapUniforms;

struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0)       uv:       vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vid: u32) -> VsOut {
  // Full-screen triangle (no vertex buffer needed).
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var out: VsOut;
  out.position = vec4<f32>(pos[vid], 0.0, 1.0);
  out.uv = pos[vid];
  return out;
}

// Signed-distance style line at spacing s along projected axis u, with width w.
fn lineMask(u: f32, s: f32, w: f32) -> f32 {
  let f = fract(u / s) * s;          // distance-along-cycle in px
  let d = min(f, s - f);              // nearest line centre
  // 1 where d is inside width/2, smooth edge for subpixel AA.
  return 1.0 - smoothstep(w * 0.5, w * 0.5 + 1.0, d);
}

fn rotate(p: vec2<f32>, a: f32) -> vec2<f32> {
  let c = cos(a);
  let s = sin(a);
  return vec2<f32>(c * p.x - s * p.y, s * p.x + c * p.y);
}

// Procedural hatch. fragCoord is in pixel units.
fn hatchIntensity(fragCoord: vec2<f32>, patternId: u32, spacing: f32, angle: f32, width: f32, angle2: f32) -> f32 {
  // All patterns ignore fragCoord translation so they're stable when the
  // camera pans — use absolute pixel coords.
  let p = fragCoord;
  if (patternId == 0u) {
    return 0.0; // solid
  }
  if (patternId == 1u) {
    // Diagonal lines
    let r = rotate(p, angle);
    return lineMask(r.x, spacing, width);
  }
  if (patternId == 2u) {
    // Cross-hatch
    let r  = rotate(p, angle);
    let r2 = rotate(p, angle2);
    let a = lineMask(r.x,  spacing, width);
    let b = lineMask(r2.x, spacing, width);
    return max(a, b);
  }
  if (patternId == 3u) {
    // Horizontal
    return lineMask(p.y, spacing, width);
  }
  if (patternId == 4u) {
    // Vertical
    return lineMask(p.x, spacing, width);
  }
  if (patternId == 5u) {
    // Concrete: coarse dots + sparse short diagonals
    let gx = fract(p.x / spacing) * spacing - spacing * 0.5;
    let gy = fract(p.y / spacing) * spacing - spacing * 0.5;
    let d  = sqrt(gx * gx + gy * gy);
    let dot = 1.0 - smoothstep(width * 0.6, width * 0.6 + 1.0, d);
    let r = rotate(p * 0.5, angle);
    let dashAlong = fract(r.x / (spacing * 2.0));
    let dashRun = step(0.0, dashAlong) * step(dashAlong, 0.35);
    let dashLine = lineMask(r.y, spacing, width);
    return max(dot, dashRun * dashLine);
  }
  if (patternId == 6u) {
    // Brick: staggered horizontal bands with vertical ticks
    let bandH = spacing;
    let band = floor(p.y / bandH);
    let offset = select(0.0, bandH, (u32(band) & 1u) == 1u);
    let horiz = lineMask(p.y, bandH, width);
    let vertPos = p.x + offset * 0.5;
    let vert = step(fract(vertPos / (bandH * 2.0)), 0.02);
    return max(horiz, vert);
  }
  if (patternId == 7u) {
    // Insulation: soft sinusoid along x, spacing controls wavelength
    let y = spacing * 0.5 * sin(p.x * 6.2831853 / spacing) + p.y;
    return lineMask(y, spacing, width);
  }
  return 0.0;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
  let patternId = u32(cap.params.x + 0.5);
  let spacing   = max(2.0, cap.params.y);
  let angle     = cap.params.z;
  let width     = max(1.0, cap.params.w);
  let angle2    = cap.params2.x;

  let h = hatchIntensity(in.position.xy, patternId, spacing, angle, width, angle2);
  // Mix hatch stroke over the fill.
  let rgb = mix(cap.fillColor.rgb, cap.strokeColor.rgb, h * cap.strokeColor.a);
  let a   = max(cap.fillColor.a, h * cap.strokeColor.a);
  return vec4<f32>(rgb, a);
}
`;
