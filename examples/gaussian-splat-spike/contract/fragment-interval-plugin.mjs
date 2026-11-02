/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { exactRunsPlugin } from './exact-runs-plugin.mjs';

// Upstream extension proposal, not a replacement Gaussian rasterizer. The
// caller owns an rg32float image of reverse-Z (lower-exclusive, upper-inclusive)
// depth intervals. Keep original shader math, global sort and blend unchanged.
export function fragmentIntervalPlugin(filter = true) {
  const base = exactRunsPlugin(true);
  return { name: 'upstream-fragment-depth-interval-8564', enforce: 'pre', async load(id) {
    const normalized = id.replaceAll('\\', '/');
    const patched = await base.load(id);
    if (normalized.endsWith('/splats/dist/splat-renderer.js')) {
      return { code: patched.code.replace('this.device = device;', 'this.device = device; this.contractDepthInterval = props.contractDepthInterval;')
        .replace('splatPositions: table.batches[0]', 'contractDepthInterval: this.contractDepthInterval, splatPositions: table.batches[0]'), map: null };
    }
    if (!normalized.endsWith('/splats/dist/splat-shaders.js')) return patched;
    let code = await readFile(id, 'utf8');
    if (createHash('sha256').update(code).digest('hex') !== 'd860f1d273aec09d7eb10d12710bc2edcffc0d596417ee1d0124fca780128369') {
      throw new Error('Unqualified upstream interval shader revision');
    }
    code = code.replace("{ name: 'splatSphericalHarmonics', type: 'read-only-storage', group: 0, location: 8 }",
      "$&, { name: 'contractDepthInterval', type: 'texture', group: 0, location: 9, viewDimension: '2d', sampleType: 'unfilterable-float' }");
    code = code.replace('@group(0) @binding(auto) var<uniform> splat : SplatUniforms;',
      '$&\n@group(0) @binding(auto) var contractDepthInterval : texture_2d<f32>;');
    code = code.replace('fn fragmentMain(input : SplatFragmentInputs) -> @location(0) vec4<f32> {', `$&
      let interval = textureLoad(contractDepthInterval, vec2<i32>(input.position.xy), 0).rg;
      ${filter ? 'if (input.position.z <= interval.x || input.position.z > interval.y) { discard; }' : ''}`);
    return { code, map: null };
  } };
}
