/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OUTLINE_IDLE_RELEASE_FRAMES, PostPassChain, type PostPassFrame, type SelectionOutlineFrame } from './post-pass-chain.js';
import type { WebGPUDevice } from './device.js';
import { VisualEnhancementResolver } from './visual-enhancement.js';

(globalThis as Record<string, unknown>).GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
(globalThis as Record<string, unknown>).GPUTextureUsage ??= { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 };
(globalThis as Record<string, unknown>).GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8, STORAGE: 128 };

function fakeDevice() {
  const live = new Set<string>();
  const pass = { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexed() {}, draw() {}, end() {} };
  let serial = 0;
  const gpu = {
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createShaderModule: () => ({}),
    createRenderPipeline: () => ({}),
    createBindGroup: () => ({}),
    createBuffer: () => ({ destroy() {} }),
    createTexture: (desc: { label?: string; size: { width: number; height: number }; format: GPUTextureFormat; sampleCount?: number }) => {
      const id = `${desc.label}#${serial++}`;
      live.add(id);
      return {
        width: desc.size.width, height: desc.size.height, depthOrArrayLayers: 1, sampleCount: desc.sampleCount ?? 1, format: desc.format,
        createView: () => ({}), destroy() { live.delete(id); },
      };
    },
    queue: { writeBuffer() {} },
  };
  const device = { getDevice: () => gpu, getFormat: () => 'bgra8unorm' } as unknown as WebGPUDevice;
  const encoder = { beginRenderPass: () => pass } as unknown as GPUCommandEncoder;
  return { device, encoder, live };
}

const outline: SelectionOutlineFrame = {
  selected: [{ vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 3, bindGroup: {} as GPUBindGroup }],
  hovered: [],
  instanced: null,
};

function frame(encoder: GPUCommandEncoder, selectionOutline: SelectionOutlineFrame | null): PostPassFrame {
  return {
    encoder, targetView: {} as GPUTextureView, width: 64, height: 64,
    depthView: {} as GPUTextureView, objectIdView: {} as GPUTextureView, maskDepthView: {} as GPUTextureView,
    projection: { m: new Float32Array(16) },
    enhancement: new VisualEnhancementResolver().resolve({ enabled: false }),
    effectsLive: true, pixelRatio: 1, edl: null, selectionOutline,
  };
}

/**
 * The outline's mask targets (one of them 4x multisampled) used to stay
 * allocated for the rest of the session once anything had been selected or
 * hovered. They are freed after a run of frames with no outline, and
 * reallocated by the next one.
 */
describe('PostPassChain outline targets', () => {
  it('frees the mask targets after an idle run of frames and reallocates them on the next outline', () => {
    const { device, encoder, live } = fakeDevice();
    const chain = new PostPassChain(device, 4, {} as GPUBindGroupLayout);
    chain.encode(frame(encoder, outline));
    const allocated = chain.renderTargets().filter((t) => t !== null).length;
    assert.equal(allocated, 3, 'visible, all and the multisampled visible mask');
    assert.equal(live.size, 3);

    for (let i = 1; i < OUTLINE_IDLE_RELEASE_FRAMES; i++) chain.encode(frame(encoder, null));
    assert.equal(live.size, 3, 'a short gap between hovers keeps them');
    chain.encode(frame(encoder, null));
    assert.equal(live.size, 0, 'released after the idle run');
    assert.ok(chain.renderTargets().every((t) => t === null));

    chain.encode(frame(encoder, outline));
    assert.equal(live.size, 3, 'the next outline reallocates them');
    chain.destroy();
    assert.equal(live.size, 0);
  });
});
