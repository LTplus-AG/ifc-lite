/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { SymbolicTextPipeline } from './symbolic-overlay-pipelines.js';
import type { SymbolicTextAtlas } from './symbolic-text-atlas.js';
import { SYMBOLIC_TEXT_WGSL } from './shaders/symbolic-overlay.wgsl.js';

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
  it('packs an f64 drawable-minus-camera text delta once before GPU upload (#5152)', () => {
    const { device, writes, getPipeline } = makeDevice();
    const pipeline = new SymbolicTextPipeline(device, 'bgra8unorm', 1, makeAtlas());
    pipeline.upload([{
      // This is deliberately near the ±1,000,000 m RTE boundary. Splitting
      // label and camera absolutes independently gives high/low lanes
      // (1_000_000, -0.075); the f64 delta must instead become
      // (999_999.9375, -0.0125) before it reaches the GPU.
      origin: [10_999_999.945, 10_999_999.9575, -50],
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
      [10_000_000.05, 10_000_000, -50],
    );

    const delta = writes.filter((write) => write.length === 8).at(-1);
    const staticInstance = writes.find((write) => write.length === 27);
    const uniform = writes.find((write) => write.length === 52);
    assert.ok(delta, 'the dynamic production text delta was not uploaded');
    assert.ok(staticInstance, 'the static production text instance was not uploaded');
    assert.ok(uniform, 'the dual-projection text draw uniform was not uploaded');
    assert.ok(Math.abs(delta[0] - 999_999.9375) < 1e-7, `wrong CPU-packed high delta: ${delta[0]}`);
    assert.ok(Math.abs(delta[4] + 0.0125) < 1e-7, `wrong CPU-packed low delta: ${delta[4]}`);
    assert.strictEqual(delta[3], 1, 'anchored records must select the RTE shader route after delta packing');
    assert.strictEqual(uniform[0], 1, 'legacy labels retain the global view-projection');
    assert.strictEqual(uniform[16], 2, 'anchored labels receive the RTE view-projection');

    // Emulate the shader's f32 clip arithmetic for an orientation whose X
    // clip component is `world.x - world.y`. Reconstituting the two eye-space
    // components first rounds their shared 999,999.9375 m high term and
    // cancels to zero; projecting high and low independently preserves the
    // 1.25 cm residual in the actual clip calculation.
    const f32 = Math.fround;
    const projectedSplit = f32(f32(delta[0] - delta[1]) + f32(delta[4] - delta[5]));
    const collapsedBeforeProjection = f32(f32(delta[0] + delta[4]) - f32(delta[1] + delta[5]));
    const expectedClip = f32((10_999_999.975 - 10_000_000.05) - (10_999_999.9375 - 10_000_000));
    assert.equal(projectedSplit, expectedClip, 'the split low lane reaches the projected coordinate');
    assert.notEqual(collapsedBeforeProjection, expectedClip, 'the old reconstructed f32 position loses the low lane');
    assert.equal(f32(delta[0] + delta[4]), delta[0], 'a raw million-metre f32 eye vector cannot itself retain this low lane');
    assert.match(
      SYMBOLIC_TEXT_WGSL,
      /viewProj \* vec4<f32>\(local \+ high, 1\.0\) \+ viewProj \* vec4<f32>\(low, 0\.0\)/,
      'the live WGSL must project high/local and low terms separately',
    );

    const staticWritesBeforeLegacyDraw = writes.filter((write) => write.length === 27).length;
    pipeline.render(pass, new Float32Array(16).fill(1), 800, 600, [1, 0, 0], [0, 1, 0]);
    const legacyDelta = writes.filter((write) => write.length === 8).at(-1);
    assert.ok(legacyDelta);
    assert.equal(legacyDelta[3], 0, 'an RTE-less render returns anchored labels to the legacy world projection');
    assert.equal(writes.filter((write) => write.length === 27).length, staticWritesBeforeLegacyDraw,
      'camera motion updates only the compact delta stream, not the atlas layout');
    assert.equal(staticInstance[17], Math.fround(10_999_999.975), 'legacy record retains its world-space f32 anchor');

    const attributes = getPipeline()?.buffers?.[2]?.attributes ?? [];
    assert.deepStrictEqual(
      attributes.map((attribute) => [attribute.shaderLocation, attribute.offset]),
      [[11, 0], [12, 4 * 4]],
      'the live pipeline must consume both CPU-packed delta lanes from the compact stream',
    );
  });
});
