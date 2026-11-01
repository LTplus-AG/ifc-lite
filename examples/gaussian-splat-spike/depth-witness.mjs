/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { webgpuAdapter } from '@luma.gl/webgpu';
import { makeGPUSplatData, SplatRenderer } from '@luma.gl/splats';
import { MathUtils } from '../../packages/renderer/src/math.ts';
import { captureTexture } from './capture.mjs';

function projection(orthographic, reverse) {
  const matrix = orthographic
    ? MathUtils.orthographicReverseZ(-1, 1, -1, 1, 0.1, 100).m
    : MathUtils.perspectiveReverseZ(Math.PI / 3, 1, 0.1, 100).m;
  // Convert clip z to w-z, preserving the identical camera and frustum.
  if (!reverse) for (let col = 0; col < 4; col++) matrix[col * 4 + 2] = matrix[col * 4 + 3] - matrix[col * 4 + 2];
  return matrix;
}

async function run() {
  const errors = [];
  const device = await webgpuAdapter.create({ createCanvasContext: false, onError: error => errors.push(error.message) });
  device.handle.addEventListener('uncapturederror', event => errors.push(event.error.message));
  const results = [];
  try {
    for (const orthographic of [false, true]) {
      const color = device.createTexture({ format: 'rgba8unorm', width: 64, height: 64, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const depth = device.createTexture({ format: 'depth32float', width: 64, height: 64, usage: GPUTextureUsage.RENDER_ATTACHMENT });
      const framebuffer = device.createFramebuffer({ colorAttachments: [color], depthStencilAttachment: depth });
      const batches = [-2, -4].map((z, i) => makeGPUSplatData(device, {
        sourceBatchIndex: i, rowIndexBase: i,
        positions: new Float32Array([0, 0, z]), scales: new Float32Array([0.3, 0.3, 0.3]),
        rotations: new Float32Array([1, 0, 0, 0]), colors: new Uint8Array(i ? [0, 0, 255, 255] : [255, 0, 0, 255]), opacities: new Float32Array([0.75]),
      }));
      const renderer = new SplatRenderer(device, { data: batches, viewportSize: [64, 64],
        modelViewProjectionMatrix: projection(orthographic, true), depthConvention: 'reverse', depthCompare: 'greater' });
      async function sample(name, props, clearDepth) {
        renderer.setProps(props);
        const encoder = device.createCommandEncoder({});
        renderer.predraw(encoder);
        const pass = encoder.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1], clearDepth });
        renderer.draw(pass); pass.end(); device.submit(encoder.finish());
        await device.handle.queue.onSubmittedWorkDone();
        const { centerPixel } = await captureTexture(device.handle, color.handle, 64, 64);
        results.push({ projection: orthographic ? 'orthographic' : 'perspective', name, centerPixel,
          order: Array.from(renderer.getSortedIndices()), visible: renderer.stats.visibleSplatCount });
      }
      try {
        await sample('reverse-constructor', {}, 0);
        // Keep the projection fixed: catches failure to invalidate cached sorting.
        await sample('standard-convention-only', { depthConvention: 'standard' }, 0);
        await sample('reverse-convention-only', { depthConvention: 'reverse' }, 0);
        await sample('standard-projection', { depthConvention: 'standard', depthCompare: 'less', modelViewProjectionMatrix: projection(orthographic, false) }, 1);
        await sample('reverse-projection', { depthConvention: 'reverse', depthCompare: 'greater', modelViewProjectionMatrix: projection(orthographic, true) }, 0);
        // An opaque depth plane at z=-3 must hide blue at -4 and retain red at -2.
        const matrix = projection(orthographic, true);
        const opaqueDepth = (-3 * matrix[10] + matrix[14]) / (-3 * matrix[11] + matrix[15]);
        await sample('opaque-depth', {}, opaqueDepth);
        await sample('source-order', { sortMode: 'none' }, 0);
      } finally {
        renderer.destroy(); batches.forEach(batch => batch.destroy());
        framebuffer.destroy(); color.destroy(); depth.destroy();
      }
    }
    return { results, errors, adapter: device.info };
  } finally { device.destroy(); }
}
window.depthWitness = run().then(result => ({ result }), error => ({ error: error.stack }));
