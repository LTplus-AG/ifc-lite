/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { makeGPUSplatData, SplatRenderer } from '@luma.gl/splats';
import { MathUtils } from '../../packages/renderer/src/math.ts';
import { captureTexture } from './capture.mjs';
// #8140: red near / blue far, each alpha .75. Back-to-front composition
// must leave red dominant at the shared centre; reverse order leaves blue.
export async function reverseZProbe(device) {
  const color = device.createTexture({ format: 'rgba8unorm', width: 64, height: 64, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const depth = device.createTexture({ format: 'depth32float', width: 64, height: 64, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const framebuffer = device.createFramebuffer({ colorAttachments: [color], depthStencilAttachment: depth });
  const batches = [-2, -4].map((z, i) => makeGPUSplatData(device, {
    positions: new Float32Array([0, 0, z]), scales: new Float32Array([0.3, 0.3, 0.3]),
    rotations: new Float32Array([1, 0, 0, 0]), colors: new Uint8Array(i ? [0, 0, 255, 255] : [255, 0, 0, 255]), opacities: new Float32Array([0.75]),
  }));
  const renderer = new SplatRenderer(device, { data: batches, modelViewProjectionMatrix: MathUtils.perspectiveReverseZ(Math.PI / 3, 1, 0.1, 100).m,
    viewportSize: [64, 64], cameraPosition: [0, 0, 0], depthCompare: 'greater', depthWriteEnabled: false });
  try {
    for (let i = 0; i < 3; i++) {
      const encoder = device.createCommandEncoder({}); renderer.predraw(encoder);
      const pass = encoder.beginRenderPass({ framebuffer, clearColor: [0, 0, 0, 1], clearDepth: 0 });
      renderer.draw(pass); pass.end(); device.submit(encoder.finish());
      await device.handle.queue.onSubmittedWorkDone();
    }
    const { centerPixel } = await captureTexture(device.handle, color.handle, 64, 64);
    return { invariant: 'near red must dominate far blue at their shared centre', centerPixel, passes: centerPixel[0] > centerPixel[2] };
  } finally { renderer.destroy(); batches.forEach(batch => batch.destroy()); framebuffer.destroy(); color.destroy(); depth.destroy(); }
}
