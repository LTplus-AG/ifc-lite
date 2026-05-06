/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Quantised + instanced rendering shader.
 *
 * Consumes the four-buffer layout produced by `parseQuantizedInstanced` in
 * the WASM bridge:
 *   - vertex buffer:  12 B/vertex (unorm16x4 position + snorm8x4 oct normal)
 *   - index buffer:   u32 indices, mesh-local (renderer applies baseVertex)
 *   - mesh table:     std140 record per unique mesh (AABB + offsets + range)
 *   - instance SSBO:  per-placement record (mat4 + expressId + colours + flags)
 *
 * Selection / ghost / visibility are flags on the per-instance record; the
 * renderer patches a single u32 in the SSBO instead of rebuilding any batch.
 *
 * The rich PBR / section / edge logic from `main.wgsl.ts` is intentionally
 * trimmed here: this shader covers the hot path we need for the prototype
 * pipeline. Visual parity with the existing pipeline lands in the follow-up
 * once the buffer layout is locked.
 */
export const quantizedShaderSource = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4<f32>,
  sectionPlane: vec4<f32>,
  flags: vec4<u32>, // x = sectionEnabled+flipped (bit0 enabled, bit1 flipped)
}
@binding(0) @group(0) var<uniform> uniforms: Uniforms;

struct MeshGpu {
  aabbMin: vec4<f32>,
  aabbMax: vec4<f32>,
  // vertex_offset, vertex_count, index_offset, index_count
  vertexInfo: vec4<u32>,
  // first_instance, instance_count, _pad, _pad
  instanceInfo: vec4<u32>,
}
@binding(1) @group(0) var<uniform> mesh: MeshGpu;

struct Instance {
  transform: mat4x4<f32>,
  // x = expressId, y = baseColor (rgba8), z = override (rgba8, 0 = no override),
  // w = flags (bit0 visible, bit1 selected, bit2 ghost)
  packed: vec4<u32>,
}
@binding(2) @group(0) var<storage, read> instances: array<Instance>;

struct VertexInput {
  // unorm16x4 → 0..1; xyz is the quantisation t, w is unused.
  @location(0) position_q: vec4<f32>,
  // snorm8x4 → -1..1; xy is octahedral, zw unused.
  @location(1) normal_oct: vec4<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) color: vec4<f32>,
  @location(3) @interpolate(flat) expressId: u32,
  @location(4) @interpolate(flat) instanceFlags: u32,
}

fn octDecode(e: vec2<f32>) -> vec3<f32> {
  var n = vec3<f32>(e, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  let sx = select(-t, t, n.x >= 0.0);
  let sy = select(-t, t, n.y >= 0.0);
  n.x = n.x + sx;
  n.y = n.y + sy;
  return normalize(n);
}

fn unpackRgba8(p: u32) -> vec4<f32> {
  return vec4<f32>(
    f32( p        & 0xffu),
    f32((p >>  8) & 0xffu),
    f32((p >> 16) & 0xffu),
    f32((p >> 24) & 0xffu)
  ) * (1.0 / 255.0);
}

// IFC stores geometry Z-up; the viewer's camera works in Y-up. The legacy
// instanced pipeline applied this rotation in the shader and the quantised
// path matches that convention so transforms produced by the existing WASM
// processors keep working unchanged.
const zToYUp = mat4x4<f32>(
  vec4<f32>(1.0, 0.0,  0.0, 0.0),
  vec4<f32>(0.0, 0.0, -1.0, 0.0),
  vec4<f32>(0.0, 1.0,  0.0, 0.0),
  vec4<f32>(0.0, 0.0,  0.0, 1.0)
);

@vertex
fn vs_main(in: VertexInput, @builtin(instance_index) iid: u32) -> VertexOutput {
  let inst = instances[mesh.instanceInfo.x + iid];
  var out: VertexOutput;

  let visible = (inst.packed.w & 1u) == 1u;
  if (!visible) {
    // Collapse the vertex outside clip space; cheaper than an indirect cull
    // path for the prototype.
    out.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    out.worldPos = vec3<f32>(0.0);
    out.normal = vec3<f32>(0.0, 1.0, 0.0);
    out.color = vec4<f32>(0.0);
    out.expressId = inst.packed.x;
    out.instanceFlags = inst.packed.w;
    return out;
  }

  // Dequantise position via per-mesh AABB, then place in world (still Z-up),
  // then rotate to viewer Y-up.
  let posLocal = mix(mesh.aabbMin.xyz, mesh.aabbMax.xyz, in.position_q.xyz);
  let worldZUp = inst.transform * vec4<f32>(posLocal, 1.0);
  let world = zToYUp * worldZUp;

  // Dequantise normal, transform by instance, rotate to Y-up.
  let nLocal = octDecode(in.normal_oct.xy);
  let nWorldZUp = (inst.transform * vec4<f32>(nLocal, 0.0)).xyz;
  let nWorld = (zToYUp * vec4<f32>(nWorldZUp, 0.0)).xyz;

  // Pick colour: override beats base.
  let base = unpackRgba8(inst.packed.y);
  let over = unpackRgba8(inst.packed.z);
  let color = select(base, over, inst.packed.z != 0u);

  out.position = uniforms.viewProj * world;
  // Z-fighting hash by expressId — same pattern as the main pipeline.
  let zHash = (inst.packed.x * 2654435761u) & 255u;
  out.position.z *= 1.0 + f32(zHash) * 1e-6;
  out.worldPos = world.xyz;
  out.normal = normalize(nWorld);
  out.color = color;
  out.expressId = inst.packed.x;
  out.instanceFlags = inst.packed.w;
  return out;
}

fn encodeId24(id: u32) -> vec4<f32> {
  return vec4<f32>(
    f32((id >> 16u) & 255u) / 255.0,
    f32((id >>  8u) & 255u) / 255.0,
    f32( id         & 255u) / 255.0,
    1.0
  );
}

struct FragmentOutput {
  @location(0) color: vec4<f32>,
  @location(1) objectIdEncoded: vec4<f32>,
}

@fragment
fn fs_main(in: VertexOutput) -> FragmentOutput {
  // DEBUG: solid magenta on every passing fragment. The dead PBR/section
  // body that lived below an early return triggered a Naga-to-Metal
  // redefinition-of-_tmp shader compile error on Mac, invalidating the
  // whole pipeline. Until we confirm pixels reach the screen the body
  // is intentionally absent.
  var out: FragmentOutput;
  out.color = vec4<f32>(1.0, 0.0, 0.6, 1.0);
  out.objectIdEncoded = encodeId24(in.expressId);
  return out;
}
`;
