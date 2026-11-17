/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { depthConventionRendererHash, publishedShadersHash, readDepthConventionRenderer, readPublishedShaders } from '../depth-patch.mjs';

// Renderer bytes served to this witness: @luma.gl/splats 9.4.2 with the workspace luma
// #3619 depthConvention patch (the later #8564 depth-interval hook blocks are stripped).
export const INSTALLED_RENDERER_SHA256 = depthConventionRendererHash;
export const UPSTREAM_SHADERS_SHA256 = publishedShadersHash;

function replaceOnce(source, anchor, replacement) {
  const count = source.split(anchor).length - 1;
  if (count !== 1) throw new Error(`Upstream shader anchor occurs ${count} times: ${anchor.slice(0, 72)}`);
  return source.replace(anchor, () => replacement);
}

function intervalEntryPoint(multisampled, filter, tie) {
  // tie 'behind' (proposal): (lower, upper]. tie 'front' is a negative control: [lower, upper).
  const [outside, inside] = tie === 'front'
    ? ['input.position.z < lower || input.position.z >= upper', 'input.position.z >= lower && input.position.z < upper']
    : ['input.position.z <= lower || input.position.z > upper', 'input.position.z > lower && input.position.z <= upper'];
  if (!multisampled) {
    return `
// #8564 reverse-Z depth interval (lower, upper] per pixel. A Gaussian exactly at
// the upper (glass) depth is kept here, so it composites behind that glass layer.
@fragment
fn fragmentMain(input : SplatFragmentInputs) -> @location(0) vec4<f32> {
  let pixel = vec2<i32>(input.position.xy);
  let lower = textureLoad(splatDepthLower, pixel, 0);
  let upper = textureLoad(splatDepthUpper, pixel, 0);
  if (${filter ? '' : 'false && '}(${outside})) {
    discard;
  }
  return evaluateSplatFragment(input);
}`;
  }
  return `
struct SplatDepthIntervalOutput {
  @location(0) color : vec4<f32>,
  @builtin(sample_mask) sampleMask : u32,
};

// #8564 per-sample reverse-Z interval (lower, upper]. Gaussian depth is constant per
// splat (all quad corners share clipCenter.zw), so the per-pixel upstream color is
// unchanged and only the set of written samples is restricted.
@fragment
fn fragmentMain(input : SplatFragmentInputs) -> SplatDepthIntervalOutput {
  let pixel = vec2<i32>(input.position.xy);
  var sampleMask = 0u;
  for (var sampleIndex = 0u; sampleIndex < textureNumSamples(splatDepthLower); sampleIndex++) {
    let lower = textureLoad(splatDepthLower, pixel, sampleIndex);
    let upper = textureLoad(splatDepthUpper, pixel, sampleIndex);
    if (${filter ? '' : 'true || '}(${inside})) {
      sampleMask |= 1u << sampleIndex;
    }
  }
  if (sampleMask == 0u) {
    discard;
  }
  return SplatDepthIntervalOutput(evaluateSplatFragment(input), sampleMask);
}`;
}

/**
 * Upstream extension proposal: two depth-texture bindings and an interval entry
 * point for the WebGPU storage shader. Projection, covariance, Gaussian alpha,
 * color, sort and blend stay upstream; the original fragment body becomes the
 * callable evaluateSplatFragment(). filter=false keeps the bindings but never
 * discards (negative control).
 */
export function extendSplatShaders(source, { samples = 1, filter = true, tie = 'behind' } = {}) {
  const multisampled = samples > 1;
  const textureType = multisampled ? 'texture_depth_multisampled_2d' : 'texture_depth_2d';
  const layout = name => `{ name: '${name}', type: 'texture', group: 0, location: ${name.endsWith('Lower') ? 9 : 10}, visibility: 2, viewDimension: '2d', sampleType: 'depth', multisampled: ${multisampled} }`;
  let code = replaceOnce(source, "{ name: 'splatSphericalHarmonics', type: 'read-only-storage', group: 0, location: 8 }",
    `{ name: 'splatSphericalHarmonics', type: 'read-only-storage', group: 0, location: 8 },\n        ${layout('splatDepthLower')},\n        ${layout('splatDepthUpper')}`);
  code = replaceOnce(code, '@fragment\nfn fragmentMain(input : SplatFragmentInputs) -> @location(0) vec4<f32> {',
    'fn evaluateSplatFragment(input : SplatFragmentInputs) -> vec4<f32> {');
  code = replaceOnce(code, '    input.colors, input.opacities, input.rowIndices\n  );\n}\n`;',
    '    input.colors, input.opacities, input.rowIndices\n  );\n}\n\n@fragment\nfn fragmentMain(input : SplatFragmentInputs) -> @location(0) vec4<f32> {\n  return evaluateSplatFragment(input);\n}\n`;');
  return replaceOnce(code, '@group(0) @binding(auto) var<storage, read> splatSphericalHarmonics : array<f32>;',
    `@group(0) @binding(auto) var<storage, read> splatSphericalHarmonics : array<f32>;
@group(0) @binding(auto) var splatDepthLower : ${textureType};
@group(0) @binding(auto) var splatDepthUpper : ${textureType};
${intervalEntryPoint(multisampled, filter, tie)}`);
}

/** Vite load hook: verified installed renderer unmodified; shader extended in memory only. */
export function peelPlugin({ samples = 1, filter = true, tie = 'behind', extend = true } = {}) {
  const loaded = new Set();
  return {
    name: 'upstream-splat-depth-interval-peel-8564', enforce: 'pre', loaded,
    async load(id) {
      const normalized = id.replaceAll('\\', '/');
      const isRenderer = normalized.endsWith('/splats/dist/splat-renderer.js');
      if (!isRenderer && !normalized.endsWith('/splats/dist/splat-shaders.js')) return undefined;
      const code = isRenderer ? await readDepthConventionRenderer(id) : await readPublishedShaders(id); // hash-verified
      loaded.add(isRenderer ? 'renderer' : 'shaders');
      return { code: isRenderer || !extend ? code : extendSplatShaders(code, { samples, filter, tie }), map: null };
    },
  };
}
