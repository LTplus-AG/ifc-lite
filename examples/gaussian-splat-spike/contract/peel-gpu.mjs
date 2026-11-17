/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Browser-only WebGPU helpers for the K-layer peel witness (#8564).
import { DEPTH_STEP, glassDepth, rectangleVertices } from './peel-scene.mjs';

export const ALPHA_OVER = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
const vec4 = values => `vec4f(${values.join(', ')})`;
const FULLSCREEN = `@vertex fn vsFull(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}`;

/**
 * Glass, opaque and peel shaders for one scene. Every glass entry point shares
 * vsGlass with an @invariant position, so peel and composite passes see identical
 * f32 depths. 1x: frag_depth = position.z, compared per pixel. multisampled:
 * per-sample invocation reading texture_depth_multisampled_2d; the depth is an
 * @interpolate(linear, sample) NDC-z varying (w = 1 here), because SwiftShader's
 * position.z is one value per pixel under sample_index shading (see peel-probe.mjs).
 */
export function sceneShader(scene, { multisampled, sampleDepth = 'varying' }) {
  const glass = scene.glass.flatMap((g, i) => rectangleVertices(scene, g.rect, (X, Y) => glassDepth(scene, i, X, Y), i));
  const opaqueDepth = scene.z0 + DEPTH_STEP * scene.opaque.u;
  const opaque = rectangleVertices(scene, scene.opaque.rect, () => opaqueDepth, 1);
  const depthType = multisampled ? 'texture_depth_multisampled_2d' : 'texture_depth_2d';
  const sampleInput = multisampled ? ', @builtin(sample_index) sampleIndex : u32' : '';
  const sample = multisampled ? 'sampleIndex' : '0';
  const z = multisampled && sampleDepth === 'varying' ? 'g.depth' : 'g.pos.z';
  return `
struct GlassOut {
  @builtin(position) @invariant pos : vec4f, @location(0) @interpolate(flat) plane : u32,${multisampled ? `
  @location(1) @interpolate(linear, sample) depth : f32,` : ''}
};
@group(0) @binding(0) var lowerDepth : ${depthType};
@group(0) @binding(1) var upperDepth : ${depthType};
fn glassColor(i : u32) -> vec4f {
  var colors = array<vec4f, ${scene.glass.length}>(${scene.glass.map(g => vec4(g.color)).join(', ')});
  return colors[i];
}
@vertex fn vsGlass(@builtin(vertex_index) i : u32) -> GlassOut {
  var v = array<vec4f, ${glass.length}>(${glass.map(vec4).join(', ')});
  return GlassOut(vec4f(v[i].xyz, 1.0), u32(v[i].w)${multisampled ? ', v[i].z' : ''});
}
@fragment fn fsPeel(g : GlassOut${sampleInput}) -> @builtin(frag_depth) f32 {
  if (${z} <= textureLoad(lowerDepth, vec2i(g.pos.xy), ${sample})) { discard; }
  return ${z};
}
@fragment fn fsComposite(g : GlassOut${sampleInput}) -> @location(0) vec4f {
  let p = vec2i(g.pos.xy);
  if (${z} <= textureLoad(lowerDepth, p, ${sample}) || ${z} > textureLoad(upperDepth, p, ${sample})) { discard; }
  return glassColor(g.plane);
}
@fragment fn fsGlass(g : GlassOut) -> @location(0) vec4f { return glassColor(g.plane); }
@vertex fn vsOpaque(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
  var v = array<vec4f, 6>(${opaque.map(vec4).join(', ')});
  return v[i];
}
@fragment fn fsOpaque() -> @location(0) vec4f { return ${vec4(scene.opaque.color)}; }
`;
}

/** Unpacks color texels or raw depth32float bits of every sample into an RGBA8 row of width size * samples. */
export function unpackShader(kind, samples) {
  const ms = samples > 1;
  const type = kind === 'depth' ? (ms ? 'texture_depth_multisampled_2d' : 'texture_depth_2d') : (ms ? 'texture_multisampled_2d<f32>' : 'texture_2d<f32>');
  return `@group(0) @binding(0) var src : ${type};
${FULLSCREEN}
@fragment fn fsUnpack(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  let p = vec2i(pos.xy);
  let texel = textureLoad(src, vec2i(p.x / ${samples}, p.y), p.x % ${samples});
  return ${kind === 'depth' ? 'unpack4x8unorm(bitcast<u32>(texel))' : 'texel'};
}`;
}

export async function checkedModule(raw, code, label, errors) {
  const module = raw.createShaderModule({ code, label });
  const messages = (await module.getCompilationInfo()).messages.filter(m => m.type === 'error')
    .map(m => `${label}:${m.lineNum}:${m.linePos} ${m.message}`);
  if (messages.length) { errors.push(...messages); throw new Error(messages.join('\n')); }
  return module;
}

export async function checkedPipeline(raw, descriptor, errors) {
  raw.pushErrorScope('validation');
  const pipeline = raw.createRenderPipeline({ layout: 'auto', ...descriptor });
  const error = await raw.popErrorScope();
  if (error) {
    errors.push(`${descriptor.label}: ${error.message}`);
    throw new Error(`${descriptor.label}: ${error.message}`);
  }
  return pipeline;
}

export async function readRGBA8(raw, texture, width, height) {
  const bytesPerRow = 256 * Math.ceil(width * 4 / 256);
  const buffer = raw.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = raw.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height]);
    raw.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buffer.getMappedRange()), out = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++) out.set(mapped.subarray(row * bytesPerRow, row * bytesPerRow + width * 4), row * width * 4);
    return out;
  } finally { buffer.destroy(); }
}

/** Renders every sample of `texture` into a size*samples x size RGBA8 image and reads it back. */
export async function unpackSamples(raw, texture, { kind, samples, size }, errors) {
  const module = await checkedModule(raw, unpackShader(kind, samples), `unpack-${kind}-${samples}`, errors);
  const pipeline = await checkedPipeline(raw, { label: `unpack-${kind}-${samples}`, vertex: { module, entryPoint: 'vsFull' },
    fragment: { module, entryPoint: 'fsUnpack', targets: [{ format: 'rgba8unorm' }] } }, errors);
  const target = raw.createTexture({ size: [size * samples, size], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  try {
    const encoder = raw.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, raw.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: texture.createView() }] }));
    pass.draw(3);
    pass.end();
    raw.queue.submit([encoder.finish()]);
    return await readRGBA8(raw, target, size * samples, size);
  } finally { target.destroy(); }
}

export function toBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
