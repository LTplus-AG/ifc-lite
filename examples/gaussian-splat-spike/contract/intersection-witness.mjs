/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { makeGPUSplatData, SplatRenderer } from '@luma.gl/splats';
import { MathUtils } from '../../../packages/renderer/src/math.ts';

// #8564: independently known per-pixel order. The upstream Gaussian has constant
// clip depth; a sloped glass triangle crosses it exactly at the viewport midpoint.
// Scissoring the reference at that crossing is exact for this constructed scene,
// NOT a proposed general compositor. Neither whole-object order can match it.
export async function intersectionWitness(device, raw, readPixels) {
  const size = 64;
  const data = makeGPUSplatData(device, { positions: new Float32Array([0, 0, -3]),
    scales: new Float32Array([0.5, 0.5, 0.5]), rotations: new Float32Array([1, 0, 0, 0]),
    colors: new Uint8Array([255, 0, 0, 255]), opacities: new Float32Array([0.75]) });
  const matrix = MathUtils.orthographicReverseZ(-1, 1, -1, 1, 0.1, 10).m;
  const centerDepth = -3 * matrix[10] + matrix[14];
  const renderer = new SplatRenderer(device, { data, viewportSize: [size, size],
    modelViewProjectionMatrix: matrix, depthCompare: 'greater', depthConvention: 'reverse' });
  const color = device.createTexture({ width: size, height: size, format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const depth = device.createTexture({ width: size, height: size, format: 'depth24plus-stencil8', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const framebuffer = device.createFramebuffer({ colorAttachments: [color], depthStencilAttachment: depth });
  const shader = raw.createShaderModule({ code: `
    @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
      var p = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.));
      return vec4f(p[i], ${centerDepth} + p[i].x * 0.05, 1.);
    }
    @fragment fn fs() -> @location(0) vec4f { return vec4f(0., 1., 0., 0.5); }
  ` });
  const glass = raw.createRenderPipeline({ layout: 'auto', vertex: { module: shader, entryPoint: 'vs' },
    fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm', blend: {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    } }] }, primitive: { topology: 'triangle-list' }, depthStencil: { format: 'depth24plus-stencil8', depthCompare: 'greater', depthWriteEnabled: false } });
  try {
    const images = {};
    for (const mode of ['reference', 'glass-first', 'splats-first']) {
      const encoder = raw.createCommandEncoder();
      const wrapped = device.createCommandEncoder({ handle: encoder });
      renderer.predraw(wrapped);
      const native = encoder.beginRenderPass({ colorAttachments: [{ view: color.handle.createView(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
        depthStencilAttachment: { view: depth.handle.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store', stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'store' } });
      const pass = device.beginRenderPass({ handle: native, framebuffer });
      const triangle = () => { native.setPipeline(glass); native.draw(3); };
      const splat = () => renderer.draw(pass);
      if (mode === 'reference') {
        native.setScissorRect(0, 0, 32, 64); triangle(); splat();
        native.setScissorRect(32, 0, 32, 64); splat(); triangle();
      } else if (mode === 'glass-first') { triangle(); splat(); }
      else { splat(); triangle(); }
      pass.end(); raw.queue.submit([encoder.finish()]); await raw.queue.onSubmittedWorkDone();
      pass.destroy(); wrapped.destroy();
      images[mode] = await readPixels(raw, color.handle, size);
    }
    const sample = pixels => [24, 40].map(x => Array.from(pixels.slice((32 * size + x) * 4, (32 * size + x) * 4 + 4)));
    const differences = mode => images[mode].reduce((count, value, i) => count + (value !== images.reference[i] ? 1 : 0), 0);
    return { referenceLeftRight: sample(images.reference), glassFirstLeftRight: sample(images['glass-first']),
      splatsFirstLeftRight: sample(images['splats-first']), glassFirstDifferentChannels: differences('glass-first'),
      splatsFirstDifferentChannels: differences('splats-first') };
  } finally { renderer.destroy(); data.destroy(); framebuffer.destroy(); color.destroy(); depth.destroy(); }
}
