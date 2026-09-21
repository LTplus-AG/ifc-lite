/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { SymbolicTextPipeline } from './symbolic-overlay-pipelines.js';
import type { SymbolicTextAtlas } from './symbolic-text-atlas.js';

// Node has no WebGPU globals. The production pipeline only consumes these
// numeric flags while this test captures the real upload and draw descriptors.
(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
(globalThis as Record<string, unknown>).GPUColorWrite = { ALL: 15 };
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  COPY_DST: 8, VERTEX: 32, UNIFORM: 64, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16,
};
(globalThis as Record<string, unknown>).GPUTextureUsage = {
  TEXTURE_BINDING: 4, COPY_DST: 8, RENDER_ATTACHMENT: 16,
};

function makeAtlas(): SymbolicTextAtlas {
  return {
    atlasSize: 64,
    glyphPx: 48,
    canvas: {},
    getVersion: () => 1,
    layoutString: () => ({
      totalAdvancePx: 12,
      glyphs: [{
        xOffsetPx: 0,
        glyph: {
          u0: 0, v0: 0, u1: 0.25, v1: 0.25,
          widthPx: 12, heightPx: 24, advancePx: 12, baselinePx: 18,
        },
      }],
    }),
  } as unknown as SymbolicTextAtlas;
}

function makeDevice(): {
  device: GPUDevice;
  writes: Float32Array[];
  getPipeline: () => GPUVertexState | undefined;
} {
  const writes: Float32Array[] = [];
  let vertex: GPUVertexState | undefined;
  const device = {
    createBindGroupLayout: () => ({}) as GPUBindGroupLayout,
    createPipelineLayout: () => ({}) as GPUPipelineLayout,
    createShaderModule: () => ({}) as GPUShaderModule,
    createRenderPipeline: (desc: GPURenderPipelineDescriptor) => {
      vertex = desc.vertex;
      return {} as GPURenderPipeline;
    },
    createBuffer: () => ({ destroy() {} }) as GPUBuffer,
    createSampler: () => ({}) as GPUSampler,
    createTexture: () => ({ createView: () => ({}) as GPUTextureView, destroy() {} }) as GPUTexture,
    createBindGroup: () => ({}) as GPUBindGroup,
    queue: {
      writeBuffer: (_buffer: GPUBuffer, _offset: number, data: ArrayBufferView) => {
        writes.push(new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
      },
      copyExternalImageToTexture() {},
    },
  } as unknown as GPUDevice;
  return { device, writes, getPipeline: () => vertex };
}

describe('SymbolicTextPipeline anchored instance ABI (#5049)', () => {
  it('keeps a 5,000-km centimetre residual through its instance and RTE draw uniforms', () => {
    const { device, writes, getPipeline } = makeDevice();
    const pipeline = new SymbolicTextPipeline(device, 'bgra8unorm', 1, makeAtlas());
    pipeline.upload([{
      origin: [5_000_000.245, 100, -50],
      worldPos: [0.03, -0.02, 0.01],
      dirX: 1,
      dirZ: 0,
      height: 0.1,
      content: 'A',
      alignment: 'bottom-left',
    }]);
    const pass = { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, draw() {} } as unknown as GPURenderPassEncoder;
    pipeline.render(
      pass,
      new Float32Array(16).fill(1),
      800,
      600,
      [1, 0, 0],
      [0, 1, 0],
      14,
      new Float32Array(16).fill(2),
      [5_000_000.25, 100, -50],
    );

    const instance = writes.find((write) => write.length === 35);
    const uniform = writes.find((write) => write.length === 52);
    assert.ok(instance, 'the widened production text instance was not uploaded');
    assert.ok(uniform, 'the dual-projection text draw uniform was not uploaded');
    const residual = (instance[27] + instance[31]) - (uniform[44] + uniform[48]);
    assert.ok(Math.abs(residual - 0.025) < 1e-7, `lost text anchor residual: ${residual}`);
    assert.strictEqual(instance[30], 1, 'anchored records must select the RTE shader route');
    assert.strictEqual(uniform[0], 1, 'legacy labels retain the global view-projection');
    assert.strictEqual(uniform[16], 2, 'anchored labels receive the RTE view-projection');

    const attributes = getPipeline()?.buffers?.[1]?.attributes ?? [];
    assert.deepStrictEqual(
      attributes.slice(-2).map((attribute) => [attribute.shaderLocation, attribute.offset]),
      [[11, 27 * 4], [12, 31 * 4]],
      'the live pipeline must consume both split-anchor lanes',
    );
  });
});
