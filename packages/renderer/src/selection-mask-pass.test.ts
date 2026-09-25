/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SelectionMaskPass, type HoveredMesh, type SelectionMaskFrame } from './selection-mask-pass.js';
import type { WebGPUDevice } from './device.js';

/**
 * GPU resource lifetime of the selection/hover mask pass (#5390 review):
 * the views object it returns must be stable per allocation (the outline
 * bind group in `edge-pass.ts` is cached by its identity), and hovering
 * must reuse ONE uniform buffer rather than allocate a buffer and bind
 * group every frame.
 */

// The fake constructs globals WebGPU would provide in a browser.
(globalThis as Record<string, unknown>).GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
(globalThis as Record<string, unknown>).GPUTextureUsage ??= { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 };
(globalThis as Record<string, unknown>).GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };

function fakeDevice() {
  const stats = { buffers: [] as { size: number; destroyed: boolean }[], bindGroups: 0, writes: 0, textures: 0 };
  const pass = { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexed() {}, end() {} };
  const gpu = {
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createShaderModule: () => ({}),
    createRenderPipeline: () => ({}),
    createTexture: () => { stats.textures++; return { createView: () => ({}), destroy() {} }; },
    createBuffer: (desc: { size: number }) => {
      const b = { size: desc.size, destroyed: false, destroy() { b.destroyed = true; } };
      stats.buffers.push(b);
      return b;
    },
    createBindGroup: () => { stats.bindGroups++; return {}; },
    queue: { writeBuffer: () => { stats.writes++; } },
  };
  const device = { getDevice: () => gpu } as unknown as WebGPUDevice;
  const encoder = { beginRenderPass: () => pass } as unknown as GPUCommandEncoder;
  return { device, encoder, stats };
}

function frame(encoder: GPUCommandEncoder, hovered: HoveredMesh | null, size = 64): SelectionMaskFrame {
  return { encoder, width: size, height: size, depthView: {} as GPUTextureView, selected: [], hovered };
}

const hoverMesh = (): HoveredMesh => ({
  vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 3, uniforms: new Float32Array(64),
});

describe('SelectionMaskPass GPU resources (#5390)', () => {
  it('returns the same views object while the targets are unchanged, a new one after a resize', () => {
    const { device, encoder } = fakeDevice();
    const pass = new SelectionMaskPass(device, {} as GPUBindGroupLayout, 1);
    const a = pass.encode(frame(encoder, hoverMesh()));
    const b = pass.encode(frame(encoder, hoverMesh()));
    assert.strictEqual(a, b, 'a fresh object per frame defeats the identity-cached outline bind group');
    const resized = pass.encode(frame(encoder, hoverMesh(), 128));
    assert.notStrictEqual(resized, a, 'new targets must invalidate the cache');
  });

  it('writes every hover frame into one owned uniform buffer and releases it on destroy', () => {
    const { device, encoder, stats } = fakeDevice();
    const pass = new SelectionMaskPass(device, {} as GPUBindGroupLayout, 1);
    for (let i = 0; i < 5; i++) pass.encode(frame(encoder, hoverMesh()));
    assert.equal(stats.buffers.length, 1, 'hovering must not allocate a uniform buffer per frame');
    assert.equal(stats.writes, 5, 'each frame writes the fresh hover uniforms');
    pass.destroy();
    assert.equal(stats.buffers[0]!.destroyed, true);
  });

  it('draws an already-bound hovered mesh without a buffer of its own', () => {
    const { device, encoder, stats } = fakeDevice();
    const pass = new SelectionMaskPass(device, {} as GPUBindGroupLayout, 1);
    pass.encode(frame(encoder, { vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 3, bindGroup: {} as GPUBindGroup }));
    assert.equal(stats.buffers.length, 0);
  });
});
