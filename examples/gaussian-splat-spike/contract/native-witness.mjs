/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { WebGPUDevice } from '@luma.gl/webgpu';
import { makeGPUSplatData, SplatRenderer } from '@luma.gl/splats';
import { intersectionWitness } from './intersection-witness.mjs';
import { MathUtils } from '../../../packages/renderer/src/math.ts';

async function readPixels(raw, texture, size) {
  const bytesPerRow = Math.ceil(size * 4 / 256) * 256;
  const buffer = raw.createBuffer({ size: bytesPerRow * size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = raw.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [size, size]);
    raw.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const source = new Uint8Array(buffer.getMappedRange());
    const pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) pixels.set(source.subarray(y * bytesPerRow, y * bytesPerRow + size * 4), y * size * 4);
    return pixels;
  } finally { buffer.destroy(); }
}
const hash = async pixels => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)), x => x.toString(16).padStart(2, '0')).join('');

function asset(device, rows, sourceBatchIndex) {
  return makeGPUSplatData(device, {
    sourceBatchIndex, rowIndexBase: sourceBatchIndex * 1000,
    positions: new Float32Array(rows.flatMap(r => [0, 0, r.z])),
    scales: new Float32Array(rows.flatMap(() => [0.5, 0.5, 0.5])),
    rotations: new Float32Array(rows.flatMap(() => [1, 0, 0, 0])),
    colors: new Uint8Array(rows.flatMap(r => r.source ? [0, 0, 255, 255] : [255, 0, 0, 255])),
    opacities: new Float32Array(rows.map(() => 0.08)),
  });
}

async function run() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU required; no skip');
  const raw = await adapter.requestDevice();
  const errors = [];
  raw.addEventListener('uncapturederror', e => errors.push(e.error.message));
  const device = new WebGPUDevice({ createCanvasContext: false, contractOwnsDevice: false, onError: e => errors.push(e.message) }, raw, adapter, adapter.info);
  const results = [];
  let intersection;
  try {
    // One renderer is resized in-place between 64 and 80, using native-owned
    // attachments/encoder/pass/submission. No canvas, loader, or splat shader.
    for (const projection of ['perspective', 'orthographic']) {
      for (const equalDepths of [false, true]) {
        const rows = Array.from({ length: 96 }, (_, i) => ({ source: i % 2,
          z: -4 + (equalDepths ? Math.floor(i / 2) * 0.04 : i * 0.02) }));
        const batches = [0, 1].map(source => asset(device, rows.filter(r => r.source === source), source));
        // The one-source reference cannot enter the source-run approximation.
        // Preserve stable source order for ties, as the upstream global sorter does.
        const referenceData = asset(device, [...rows.filter(r => !r.source), ...rows.filter(r => r.source)], 2);
        const matrix = projection === 'perspective'
          ? MathUtils.perspectiveReverseZ(Math.PI / 3, 1, 0.1, 100).m
          : MathUtils.orthographicReverseZ(-1, 1, -1, 1, 0.1, 100).m;
        const props = { modelViewProjectionMatrix: matrix, depthConvention: 'reverse', depthCompare: 'greater' };
        const combined = new SplatRenderer(device, { ...props, data: batches });
        const reference = new SplatRenderer(device, { ...props, data: referenceData });
        try {
          for (const size of [64, 80]) for (const sampleCount of [1, 4]) {
            const usage = GPUTextureUsage.RENDER_ATTACHMENT;
            const output = raw.createTexture({ size: [size, size], format: 'rgba8unorm', usage: usage | GPUTextureUsage.COPY_SRC });
            const color = sampleCount === 1 ? output : raw.createTexture({ size: [size, size], format: 'rgba8unorm', sampleCount, usage });
            const depth = raw.createTexture({ size: [size, size], format: 'depth24plus-stencil8', sampleCount, usage });
            const colorView = device.createTexture({ handle: color, width: size, height: size, format: 'rgba8unorm', samples: sampleCount, usage });
            const depthView = device.createTexture({ handle: depth, width: size, height: size, format: 'depth24plus-stencil8', samples: sampleCount, usage });
            const framebuffer = device.createFramebuffer({ width: size, height: size, colorAttachments: [colorView], depthStencilAttachment: depthView });
            const capture = async renderer => {
              renderer.setProps({ viewportSize: [size, size] });
              const encoder = raw.createCommandEncoder();
              const wrappedEncoder = device.createCommandEncoder({ handle: encoder });
              renderer.predraw(wrappedEncoder);
              const nativePass = encoder.beginRenderPass({ colorAttachments: [{ view: color.createView(),
                ...(sampleCount > 1 ? { resolveTarget: output.createView() } : {}), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
                depthStencilAttachment: { view: depth.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store',
                  stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'store' } });
              const pass = device.beginRenderPass({ handle: nativePass, framebuffer });
              const drawn = renderer.draw(pass);
              pass.end(); raw.queue.submit([encoder.finish()]);
              await raw.queue.onSubmittedWorkDone();
              pass.destroy(); wrappedEncoder.destroy();
              if (!drawn) throw new Error('No splats drawn');
              return readPixels(raw, output, size);
            };
            try {
              const expected = await capture(reference), actual = await capture(combined);
              let changedPixels = 0, maximumChannelError = 0;
              for (let p = 0; p < actual.length; p += 4) {
                if (actual.subarray(p, p + 4).some((v, c) => v !== expected[p + c])) changedPixels++;
                for (let c = 0; c < 4; c++) maximumChannelError = Math.max(maximumChannelError, Math.abs(actual[p + c] - expected[p + c]));
              }
              const center = (Math.floor(size / 2) * size + Math.floor(size / 2)) * 4;
              results.push({ projection, equalDepths, size, sampleCount, drawRuns: combined.getDrawRuns().length,
                changedPixels, maximumChannelError, referenceHash: await hash(expected), actualHash: await hash(actual),
                center: Array.from(actual.slice(center, center + 4)), referenceCenter: Array.from(expected.slice(center, center + 4)) });
            } finally {
              framebuffer.destroy(); colorView.destroy(); depthView.destroy();
              output.destroy(); if (color !== output) color.destroy(); depth.destroy();
            }
          }
        } finally { combined.destroy(); reference.destroy(); batches.forEach(b => b.destroy()); referenceData.destroy(); }
      }
    }
    intersection = await intersectionWitness(device, raw, readPixels);
  } finally { device.destroy(); }
  raw.pushErrorScope('validation');
  const survivor = raw.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST });
  const encoder = raw.createCommandEncoder(); encoder.clearBuffer(survivor); raw.queue.submit([encoder.finish()]);
  await raw.queue.onSubmittedWorkDone();
  const ownershipError = await raw.popErrorScope();
  survivor.destroy(); raw.destroy();
  return { results, intersection, errors, ownershipError: ownershipError?.message ?? null, gpu: device.info };
}
window.nativeWitness = run().then(result => ({ result }), error => ({ error: error.stack }));
