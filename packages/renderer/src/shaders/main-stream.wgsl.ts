/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Stateless draw-stream variant of the main shader (`draw-stream.ts`),
 * derived textually from `main.wgsl.ts` the way `main-opaque-fast.wgsl.ts` is.
 *
 * The per-draw `uniforms` block becomes a private copy assembled from three
 * sources, so one bind group serves every colour batch of a frame and draws
 * differ only in `firstInstance` (the batch's record index):
 *  - binding 0: the frame-wide `Uniforms` (camera, section, clip box, flags),
 *    written once per frame;
 *  - binding 1: one static `StreamDraw` record per batch (colour, material,
 *    dequantisation, f32 model origin, colour-table anchor + mode bits);
 *  - binding 2: two vec4 per batch, the camera-relative origin delta split
 *    into high/low on the CPU in f64 exactly like the legacy per-draw packing,
 *    so stream draws write the same depth as the legacy highlight redraw.
 * The record index reaches the fragment stage as a flat varying.
 */
export const STREAM_RECORD_FLOATS = 24;
export const STREAM_DELTA_FLOATS = 8;
const STREAM_VARYING_LOCATION = 13;

function replaceOnce(source: string, find: string | RegExp, replacement: string, what: string): string {
  const matches = typeof find === 'string' ? source.split(find).length - 1 : (source.match(new RegExp(find.source, 'g')) ?? []).length;
  if (matches !== 1) throw new Error(`main-stream.wgsl: expected one ${what}, found ${matches}; update the derivation.`);
  return source.replace(find, replacement);
}

/** Derive the stream module from a main-shader source (full or discard-free). */
export function streamShaderSource(base: string): string {
  let s = replaceOnce(base, '@binding(0) @group(0) var<uniform> uniforms: Uniforms;', `
        @binding(0) @group(0) var<uniform> frameUniforms: Uniforms;
        struct StreamDraw {
          baseColor: vec4<f32>,
          material: vec4<f32>,    // metallic, roughness, transmission.x, transmission.y
          quantParams: vec4<f32>,
          origin: vec4<f32>,      // f32 model translation (legacy uniforms.model[3])
          bits: vec4<u32>,        // x: unused (flags are frame-wide), y/z/w: overrideParams.xyz
          pad: vec4<u32>,
        }
        @binding(1) @group(0) var<storage, read> streamDraws: array<StreamDraw>;
        @binding(2) @group(0) var<storage, read> streamDeltas: array<vec4<f32>>;
        var<private> uniforms: Uniforms;
        // Frame-wide fields are read straight from frameUniforms (rewritten below); only the
        // per-draw fields live in the private copy, so no whole-struct copy per invocation.
        fn loadStreamUniforms(i: u32) {
          let d = streamDraws[i];
          uniforms.baseColor = d.baseColor;
          uniforms.metallicRoughness = d.material.xy;
          uniforms.transmission = d.material.zw;
          uniforms.quantParams = d.quantParams;
          uniforms.model = mat4x4<f32>(vec4<f32>(1.0, 0.0, 0.0, 0.0), vec4<f32>(0.0, 1.0, 0.0, 0.0), vec4<f32>(0.0, 0.0, 1.0, 0.0), vec4<f32>(d.origin.xyz, 1.0));
          uniforms.drawableDeltaHigh = streamDeltas[2u * i];
          uniforms.drawableDeltaLow = streamDeltas[2u * i + 1u];
          uniforms.overrideParams = vec4<u32>(d.bits.y, d.bits.z, d.bits.w, 0u);
        }`, 'uniform declaration');
  // Everything but the per-draw fields is frame-wide: read it from the uniform directly.
  const frameWide = /\buniforms\.(viewProj|sectionPlane|flags|clipBoxMin|clipBoxMax|rteViewProj|rteCameraHigh|rteCameraLow|extraClip)\b/g;
  const loader = s.indexOf('fn loadStreamUniforms(');
  s = s.slice(0, loader).replace(frameWide, 'frameUniforms.$1') + s.slice(loader, s.indexOf('}', loader) + 1)
    + s.slice(s.indexOf('}', loader) + 1).replace(frameWide, 'frameUniforms.$1');
  s = replaceOnce(s, 'struct VertexOutput {', `struct VertexOutput {
          @location(${STREAM_VARYING_LOCATION}) @interpolate(flat) streamDraw: u32,`, 'VertexOutput struct');
  s = replaceOnce(s, /@fragment\s+fn fs_main\(input: VertexOutput\) -> FragmentOutput \{/, 'fn fs_main_body(input: VertexOutput) -> FragmentOutput {', 'fs_main entry');
  s += `
        @fragment
        fn fs_main(input: VertexOutput) -> FragmentOutput {
          loadStreamUniforms(input.streamDraw);
          return fs_main_body(input);
        }

        @vertex
        fn vs_stream_quantized(input: QuantizedVertexInput, @builtin(instance_index) drawIndex: u32) -> VertexOutput {
          loadStreamUniforms(drawIndex);
          let p = uniforms.quantParams.xyz
            + vec3<f32>(f32(input.q.x), f32(input.q.y), f32(input.q.z)) * uniforms.quantParams.w;
          var o = shadeFlatVertex(p, octDecodeN(input.q.w), input.entityId);
          o.streamDraw = drawIndex;
          return o;
        }

        @vertex
        fn vs_stream(input: VertexInput, @builtin(instance_index) drawIndex: u32) -> VertexOutput {
          loadStreamUniforms(drawIndex);
          var o = shadeFlatVertex(input.position, input.normal, input.entityId);
          o.streamDraw = drawIndex;
          return o;
        }
`;
  return s;
}
