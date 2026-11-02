/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { WebGPUDevice } from '@luma.gl/webgpu';
import { makeGPUSplatData, SplatRenderer } from '@luma.gl/splats';
import { MathUtils } from '../../../packages/renderer/src/math.ts';
import { normalizeGaussianAttributes } from '../../../packages/renderer/src/gaussian/gaussian-attributes.ts';

async function capture(raw, texture, size) {
  const bytesPerRow = 256 * Math.ceil(size * 4 / 256);
  const buffer = raw.createBuffer({ size: bytesPerRow * size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = raw.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [size, size]);
    raw.queue.submit([encoder.finish()]); await buffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buffer.getMappedRange());
    return Uint8Array.from({ length: size * size * 4 }, (_, i) => mapped[Math.floor(i / (size * 4)) * bytesPerRow + i % (size * 4)]);
  } finally { buffer.destroy(); }
}

async function witness(device, raw, projection, size, slope) {
  const owned = [];
  const own = value => { owned.push(value); return value; };
  try {
    const matrix = projection === 'orthographic' ? MathUtils.orthographicReverseZ(-1, 1, -1, 1, 0.1, 10).m
      : MathUtils.perspectiveReverseZ(Math.PI / 3, 1, 0.1, 10).m;
    const z = -3, center = (z * matrix[10] + matrix[14]) / (z * matrix[11] + matrix[15]);
    const dc = 0.28209479177387814;
    const columns = Object.fromEntries(Object.entries({ x: 0, y: 0, z,
      scale_0: Math.log(0.5), scale_1: Math.log(0.3), scale_2: Math.log(0.2),
      rot_0: 2, rot_1: 0, rot_2: 0, rot_3: 0, opacity: Math.log(3),
      f_dc_0: 0.5 / dc, f_dc_1: -0.5 / dc, f_dc_2: -0.5 / dc,
    }).map(([key, value]) => [key, new Float32Array([value])]));
    const data = own(makeGPUSplatData(device, normalizeGaussianAttributes({ count: 1, shDegree: 0, columns })));
    const texture = (format, usage) => own(device.createTexture({ width: size, height: size, format, usage }));
    const color = texture('rgba8unorm', GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
    const depth = texture('depth24plus-stencil8', GPUTextureUsage.RENDER_ATTACHMENT);
    const framebuffer = own(device.createFramebuffer({ colorAttachments: [color], depthStencilAttachment: depth }));
    const intervals = ['all', 'far', 'near'].map(() => texture('rg32float', GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING));
    const renderers = intervals.map(contractDepthInterval => own(new SplatRenderer(device, {
      data, viewportSize: [size, size], modelViewProjectionMatrix: matrix, depthCompare: 'greater',
      depthConvention: 'reverse', contractDepthInterval,
    })));
    const shader = raw.createShaderModule({ code: `
      @vertex fn vs(@builtin(vertex_index) i:u32) -> @builtin(position) vec4f {
        var p=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));
        return vec4f(p[i], ${center} + dot(p[i], vec2f(${slope[0]}, ${slope[1]})), 1.);
      }
      @fragment fn fs() -> @location(0) vec4f { return vec4f(0.,1.,0.,0.5); }
      @fragment fn far(@builtin(position) p:vec4f) -> @location(0) vec2f { return vec2f(0.,p.z); }
      @fragment fn near(@builtin(position) p:vec4f) -> @location(0) vec2f { return vec2f(p.z,1.); }
    ` });
    const glass = raw.createRenderPipeline({ layout: 'auto', vertex: { module: shader, entryPoint: 'vs' },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm', blend: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      } }] }, depthStencil: { format: 'depth24plus-stencil8', depthCompare: 'greater', depthWriteEnabled: false } });
    const intervalPipelines = ['far', 'near'].map(entryPoint => raw.createRenderPipeline({ layout: 'auto',
      vertex: { module: shader, entryPoint: 'vs' }, fragment: { module: shader, entryPoint, targets: [{ format: 'rg32float' }] } }));
    const images = {};
    for (const mode of ['reference', 'interval']) {
      const encoder = raw.createCommandEncoder(), wrapped = device.createCommandEncoder({ handle: encoder });
      try {
        // The native triangle rasterizer writes the actual fragment depth; no
        // CPU plane intersection or scissor appears on the candidate path.
        intervals.forEach((interval, i) => {
          const pass = encoder.beginRenderPass({ colorAttachments: [{ view: interval.handle.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 1, 0, 0] }] });
          if (i) { pass.setPipeline(intervalPipelines[i - 1]); pass.draw(3); }
          pass.end();
        });
        renderers.forEach(renderer => renderer.predraw(wrapped));
        const native = encoder.beginRenderPass({ colorAttachments: [{ view: color.handle.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
          depthStencilAttachment: { view: depth.handle.createView(), depthLoadOp: 'clear', depthStoreOp: 'store', depthClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'store', stencilClearValue: 0 } });
        const pass = device.beginRenderPass({ handle: native, framebuffer });
        const triangle = () => { native.setPipeline(glass); native.draw(3); };
        try {
          if (mode === 'interval') { renderers[1].draw(pass); triangle(); renderers[2].draw(pass); }
          else {
            // Independent known per-pixel reference. Pixel-center plane depth
            // determines order; no interval texture is consulted.
            for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
              native.setScissorRect(x, y, 1, 1);
              const delta = (2 * (x + 0.5) / size - 1) * slope[0] + (1 - 2 * (y + 0.5) / size) * slope[1];
              if (delta < 0) { triangle(); renderers[0].draw(pass); }
              else { renderers[0].draw(pass); triangle(); }
            }
          }
          pass.end(); raw.queue.submit([encoder.finish()]); await raw.queue.onSubmittedWorkDone();
        } finally { pass.destroy(); }
      } finally { wrapped.destroy(); }
      images[mode] = await capture(raw, color.handle, size);
    }
    const differentChannels = images.interval.reduce((n, v, i) => n + (v !== images.reference[i] ? 1 : 0), 0);
    return { projection, size, slope, differentChannels, referenceNonzero: images.reference.some((v, i) => i % 4 !== 3 && v > 0) };
  } finally { for (const resource of owned.reverse()) resource.destroy(); }
}

async function run() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU required, no skip');
  const raw = await adapter.requestDevice(), errors = [];
  raw.addEventListener('uncapturederror', e => errors.push(e.error.message));
  const device = new WebGPUDevice({ createCanvasContext: false, contractOwnsDevice: false, onError: e => errors.push(e.message) }, raw, adapter, adapter.info);
  try {
    const cases = [];
    for (const projection of ['orthographic', 'perspective']) for (const size of [24, 32]) {
      cases.push(await witness(device, raw, projection, size, [0.009, 0.0037]));
    }
    return { cases, errors, productionReady: false, limitations: ['one transparent layer', '1x MSAA', 'bounded upstream CPU ordering', 'no viewer frame integration'] };
  } finally { device.destroy(); raw.destroy(); }
}
window.intervalWitness = run().then(result => ({ result }), error => ({ error: error.stack }));
