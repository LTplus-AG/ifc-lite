/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// 4x per-sample output semantics probe for the peel witness (#8564). Each invocation
// uses @builtin(sample_index) (or sample interpolation); the probe records what
// reaches each sample of pixel (0, 0) in a 2x2 target.
import { ALPHA_OVER, checkedModule, checkedPipeline, unpackSamples } from './peel-gpu.mjs';
import { SAMPLE_POSITIONS } from './peel-scene.mjs';

const SHADER = `
struct Sloped { @builtin(position) pos : vec4f, @location(0) @interpolate(linear, sample) depth : f32 };
@vertex fn vsFull(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.5, 1.0);
}
@vertex fn vsSloped(@builtin(vertex_index) i : u32) -> Sloped {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let z = 0.5 + 0.25 * p[i].x;
  return Sloped(vec4f(p[i], z, 1.0), z);
}
@vertex fn vsSlopedY(@builtin(vertex_index) i : u32) -> Sloped {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let z = 0.5 + 0.25 * p[i].y;
  return Sloped(vec4f(p[i], z, 1.0), z);
}
// Covers x_ndc < -0.5, i.e. the left half (x < 0.5 px) of pixel (0, 0) in a 2x2 target.
@vertex fn vsLeftHalf(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-3.0, -3.0), vec2f(-0.5, -3.0), vec2f(-0.5, 3.0));
  return vec4f(p[i], 0.5, 1.0);
}
@fragment fn fsRed() -> @location(0) vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }
struct DepthMasked { @builtin(frag_depth) depth : f32, @builtin(sample_mask) mask : u32 };
@fragment fn fsPosition(@builtin(position) pos : vec4f, @builtin(sample_index) s : u32) -> @location(0) vec4f {
  return vec4f(fract(pos.x), fract(pos.y), f32(s) / 255.0, 1.0);
}
@fragment fn fsDepth(@builtin(sample_index) s : u32) -> @builtin(frag_depth) f32 { return 0.125 * f32(s + 1u); }
@fragment fn fsDepthMasked(@builtin(sample_index) s : u32) -> DepthMasked { return DepthMasked(0.125 * f32(s + 1u), 1u << s); }
@fragment fn fsPositionZ(v : Sloped, @builtin(sample_index) s : u32) -> @builtin(frag_depth) f32 { return v.pos.z + 0.0 * f32(s); }
@fragment fn fsVaryingZ(v : Sloped) -> @builtin(frag_depth) f32 { return v.depth; }
@fragment fn fsDiscardOdd(@builtin(sample_index) s : u32) -> @location(0) vec4f {
  if ((s & 1u) == 1u) { discard; }
  return vec4f(1.0, 0.0, 0.0, 1.0);
}
@fragment fn fsBlend(@builtin(sample_index) s : u32) -> @location(0) vec4f { return vec4f(1.0, 1.0, 1.0, 0.5 + 0.0 * f32(s)); }
`;

async function draw(raw, module, errors, { vertex = 'vsFull', entryPoint, format, depth, blend }) {
  // entryPoint undefined: no fragment stage, fixed-function depth only.
  const isDepth = format === 'depth32float';
  const fragment = entryPoint ? { module, entryPoint, targets: isDepth ? [] : [{ format, ...(blend ? { blend } : {}) }] } : undefined;
  const pipeline = await checkedPipeline(raw, { label: `probe-${vertex}-${entryPoint ?? 'fixed'}-${depth?.compare ?? 'color'}`, multisample: { count: 4 },
    vertex: { module, entryPoint: vertex }, fragment,
    ...(isDepth ? { depthStencil: { format, depthCompare: depth.compare, depthWriteEnabled: true } } : {}) }, errors);
  const target = raw.createTexture({ size: [2, 2], format, sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
  try {
    const encoder = raw.createCommandEncoder(), view = target.createView();
    const pass = encoder.beginRenderPass(isDepth
      ? { colorAttachments: [], depthStencilAttachment: { view, depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: depth.clear } }
      : { colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(pipeline); pass.draw(3); pass.end();
    raw.queue.submit([encoder.finish()]);
    const bytes = await unpackSamples(raw, target, { kind: isDepth ? 'depth' : 'color', samples: 4, size: 2 }, errors);
    return isDepth ? Array.from(new Float32Array(bytes.buffer).slice(0, 4)) : [0, 1, 2, 3].map(s => Array.from(bytes.slice(s * 4, s * 4 + 4)));
  } finally { target.destroy(); }
}

/** Records per-sample position, depth source, depth-write, discard and blend semantics. */
export async function probeSampleShading(raw, errors) {
  const module = await checkedModule(raw, SHADER, 'sample-shading-probe', errors);
  const color = entryPoint => draw(raw, module, errors, { entryPoint, format: 'rgba8unorm' });
  const depth = (entryPoint, compare, clear, vertex) => draw(raw, module, errors, { vertex, entryPoint, format: 'depth32float', depth: { compare, clear } });
  const position = await color('fsPosition');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Analytic depth of z = 0.5 + 0.25 * x_ndc at the four standard sample positions of pixel (0, 0).
  const slopedExpected = SAMPLE_POSITIONS[4].map(([ox]) => 0.5 + 0.25 * (ox - 1));
  const slopedYExpected = SAMPLE_POSITIONS[4].map(([, oy]) => 0.5 + 0.25 * (1 - oy));
  const result = {
    positions: position.map(([r, g]) => [r / 255, g / 255]),
    standardPositions: same(position.map(t => t.slice(0, 3)), SAMPLE_POSITIONS[4].map(([x, y], s) => [Math.round(x * 255), Math.round(y * 255), s])),
    fragDepthConstantLess: await depth('fsDepth', 'less', 1),
    fragDepthMaskedLess: await depth('fsDepthMasked', 'less', 1),
    slopedExpected,
    slopedFixedFunction: await depth(undefined, 'always', 1, 'vsSloped'),
    slopedPositionZ: await depth('fsPositionZ', 'always', 1, 'vsSloped'),
    slopedSampleVarying: await depth('fsVaryingZ', 'always', 1, 'vsSloped'),
    slopedYExpected,
    slopedYFixedFunction: await depth(undefined, 'always', 1, 'vsSlopedY'),
    slopedYPositionZ: await depth('fsPositionZ', 'always', 1, 'vsSlopedY'),
    slopedYSampleVarying: await depth('fsVaryingZ', 'always', 1, 'vsSlopedY'),
    leftHalfCoverageRed: (await draw(raw, module, errors, { vertex: 'vsLeftHalf', entryPoint: 'fsRed', format: 'rgba8unorm' })).map(t => t[0]),
    discardOddRed: (await color('fsDiscardOdd')).map(t => t[0]),
    blendHalfWhite: (await draw(raw, module, errors, { entryPoint: 'fsBlend', format: 'rgba8unorm', blend: ALPHA_OVER })).map(t => t[0]),
  };
  Object.assign(result, {
    perSampleFragDepthWrite: same(result.fragDepthConstantLess, [0.125, 0.25, 0.375, 0.5]),
    perSampleFixedFunctionDepth: same(result.slopedFixedFunction, slopedExpected) && same(result.slopedYFixedFunction, slopedYExpected),
    perSamplePositionZ: same(result.slopedPositionZ, slopedExpected) && same(result.slopedYPositionZ, slopedYExpected),
    perSampleVaryingDepth: same(result.slopedSampleVarying, slopedExpected) && same(result.slopedYSampleVarying, slopedYExpected),
    standardCoverage: same(result.leftHalfCoverageRed, [255, 0, 255, 0]),
    perSampleDiscard: same(result.discardOddRed, [255, 0, 255, 0]),
    perSampleBlendOnce: result.blendHalfWhite.every(v => v === 128),
  });
  return result;
}
