/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { depthNudgeWgsl } from './depth-nudge.wgsl.js';

/** Bind after mesh and environment/hover groups. Shared by colour and masks. */
export const OPAQUE_VISIBILITY_GROUP = 2;

/** Numerical coincidence allowance, independent of the entity's hash rank. */
export const OPAQUE_VISIBILITY_ULPS = 4;

export function opaqueVisibilityWgsl(samples: number): string {
  return `
    @group(${OPAQUE_VISIBILITY_GROUP}) @binding(0) var geometricDepth: ${samples > 1 ? 'texture_depth_multisampled_2d' : 'texture_depth_2d'};
    fn geometricallyOccluded(pixel: vec2<f32>, depth: f32, sampleIndex: u32) -> bool {
      let nearest = textureLoad(geometricDepth, vec2<i32>(pixel), ${samples > 1 ? 'i32(sampleIndex)' : '0'});
      // depth32float prepass: allow only raster interpolation roundoff. Unlike
      // the old 256-rank nudge, this tolerance never grows with the hash.
      let bits = bitcast<u32>(nearest);
      let lower = bitcast<f32>(bits - min(bits, ${OPAQUE_VISIBILITY_ULPS}u));
      return depth < lower;
    }
  `;
}

/** Same transformations and fragment discards, without entity displacement. */
export function unbiasedMeshShader(source: string, samples: number, entryPoint = 'fs_main'): string {
  if (!source.includes(depthNudgeWgsl)) throw new Error('Mesh shader has no canonical depth nudge');
  const unbiased = source.replace(depthNudgeWgsl,
    'fn nudgedClipZ(clip: vec4<f32>, hash: u32, vp: mat4x4<f32>) -> f32 { return clip.z; }')
    .replace('@location(8) @interpolate(linear)', '@location(8) @interpolate(linear, sample)');
  const entry = unbiased.indexOf(`fn ${entryPoint}(input: VertexOutput)`);
  const attribute = unbiased.lastIndexOf('@fragment', entry);
  if (entry < 0 || attribute < 0) throw new Error('Visibility prepass has no fragment eligibility entry');
  // Invoke the real fragment for its discards, then store the SAME sampled
  // interpolant colour/masks compare. Mixing fixed-function MSAA depth with
  // shader-interpolated depth can compare different raster sample positions.
  const eligibility = unbiased.slice(attribute + '@fragment'.length)
    .replace(/(fn \w+\(input: VertexOutput\)\s*->)\s*@location\(0\)/, '$1');
  return unbiased.slice(0, attribute) + eligibility + `
    @fragment fn fs_geometric_depth(input: VertexOutput, @builtin(sample_index) sampleIndex: u32) -> @builtin(frag_depth) f32 {
      let eligible = ${entryPoint}(input);
      if (sampleIndex >= ${samples}u) { discard; }
      return input.geometricDepth;
    }
  `;
}

/** Guard an actual colour fragment; keep its clipping, texture and opacity rules. */
export function guardedMeshShader(source: string, samples: number, entryPoint = 'fs_main'): string {
  const anchor = `fn ${entryPoint}(input: VertexOutput)`;
  if (!source.includes(anchor)) throw new Error(`Visibility fragment ${entryPoint} has no canonical input`);
  const signature = source.replace(anchor, `fn ${entryPoint}(input: VertexOutput, @builtin(sample_index) sampleIndex: u32)`);
  const start = signature.indexOf('{', signature.indexOf(`fn ${entryPoint}(`));
  const guard = '\n if (geometricallyOccluded(input.position.xy, input.geometricDepth, sampleIndex)) { discard; }\n';
  return (opaqueVisibilityWgsl(samples) + signature.slice(0, start + 1) + guard + signature.slice(start + 1))
    .replace('@location(8) @interpolate(linear)', '@location(8) @interpolate(linear, sample)');
}
