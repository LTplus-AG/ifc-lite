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
  it('keeps an anchored non-billboard glyph at its world position without an RTE frame (#5152)', () => {
    const { device, writes } = makeDevice();
    const pipeline = new SymbolicTextPipeline(device, 'bgra8unorm', 1, makeAtlas());
    pipeline.upload([{
      origin: [100, 200, 300], worldPos: [0.125, 0, 0], dirX: 1, dirZ: 0,
      height: 0.48, content: 'A', alignment: 'bottom-right',
    }]);
    const pass = { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, draw() {} } as unknown as GPURenderPassEncoder;
    pipeline.render(pass, new Float32Array(16).fill(1), 800, 600, [1, 0, 0], [0, 1, 0]);

    const staticInstance = writes.find((write) => write.length === 27);
    const legacyDelta = writes.filter((write) => write.length === 8).at(-1);
    assert.ok(staticInstance);
    assert.ok(legacyDelta);
    assert.equal(legacyDelta[3], 0, 'no RTE frame selects the legacy projection');
    assert.equal(legacyDelta[7], 1, 'the legacy route knows this static origin is anchor-local');
    // This emulates the live selected shader expression at scale=0.5. The
    // former `origin - anchor` branch produced about 50m instead of 100.065m.
    // The quad's left edge sits one halo margin (#5388) left of the glyph. The
    // margin is read back from the uploaded UVs (atlas px = -u0 * atlasSize),
    // at 0.01 m per atlas px (0.48 m / 48 px).
    const haloAtlasPx = -staticInstance[9] * 64;
    const expectedQuadX = 100.065 - haloAtlasPx * 0.01 * 0.5;
    const actualWorldX = Math.fround(staticInstance[17] + Math.fround(staticInstance[0] * 0.5));
    const oldWorldX = Math.fround(staticInstance[17] + Math.fround((staticInstance[0] - staticInstance[17]) * 0.5));
    assert.ok(Math.abs(actualWorldX - expectedQuadX) < 1e-5, `anchored legacy glyph moved to ${actualWorldX}`);
    assert.ok(Math.abs(oldWorldX - actualWorldX) > 1, 'the regression fixture must expose the old translation loss');
  });

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
    const glyphLocalX = 0.01;
    const projectedSplit = f32(f32(delta[0] - delta[1]) + f32((glyphLocalX + delta[4]) - delta[5]));
    const collapsedBeforeProjection = f32(f32(delta[0] + glyphLocalX + delta[4]) - f32(delta[1] + delta[5]));
    const expectedClip = f32((10_999_999.975 - 10_000_000.05 + glyphLocalX) - (10_999_999.9375 - 10_000_000));
    assert.equal(projectedSplit, expectedClip, 'the split low lane reaches the projected coordinate');
    assert.notEqual(collapsedBeforeProjection, expectedClip, 'the old high-plus-local path loses the centimetre glyph extent');
    assert.equal(f32(delta[0] + delta[4]), delta[0], 'a raw million-metre f32 eye vector cannot itself retain this low lane');
    assert.match(
      SYMBOLIC_TEXT_WGSL,
      /viewProj \* vec4<f32>\(high, 1\.0\) \+ viewProj \* vec4<f32>\(local \+ low, 0\.0\)/,
      'the live WGSL must project high and local-plus-low terms separately',
    );

    const staticWritesBeforeLegacyDraw = writes.filter((write) => write.length === 27).length;
    pipeline.render(pass, new Float32Array(16).fill(1), 800, 600, [1, 0, 0], [0, 1, 0]);
    const legacyDelta = writes.filter((write) => write.length === 8).at(-1);
    assert.ok(legacyDelta);
    assert.equal(legacyDelta[3], 0, 'an RTE-less render returns anchored labels to the legacy world projection');
    assert.equal(legacyDelta[7], 1, 'an anchored legacy glyph retains its local-origin marker');
    assert.equal(writes.filter((write) => write.length === 27).length, staticWritesBeforeLegacyDraw,
      'camera motion updates only the compact delta stream, not the atlas layout');
    assert.equal(staticInstance[17], Math.fround(10_999_999.975), 'legacy record retains its world-space f32 anchor');

    assert.match(SYMBOLIC_TEXT_WGSL, /select\(inst\.origin - inst\.anchor, inst\.origin, hasLocalOrigin\)/,
      'the legacy shader branch uses an anchor-local origin when its marker is set');

    const attributes = getPipeline()?.buffers?.[2]?.attributes ?? [];
    assert.deepStrictEqual(
      attributes.map((attribute) => [attribute.shaderLocation, attribute.offset]),
      [[11, 0], [12, 4 * 4]],
      'the live pipeline must consume both CPU-packed delta lanes from the compact stream',
    );
  });
});

describe('SymbolicTextPipeline eye-envelope skip (#6128)', () => {
  it('draws only the in-envelope label runs instead of throwing for a far label', () => {
    const { device } = makeDevice();
    const pipeline = new SymbolicTextPipeline(device, 'bgra8unorm', 1, makeAtlas());
    const label = (x: number) => ({
      origin: [x, 0, 0] as [number, number, number], worldPos: [0, 0, 0] as [number, number, number],
      dirX: 1, dirZ: 0, height: 0.1, content: 'A', alignment: 'bottom-left' as const,
    });
    // One glyph per label: instances 0 and 2 are near the camera, 1 is 1,500 km away.
    pipeline.upload([label(1), label(1_500_000), label(2)]);
    const draws: number[][] = [];
    const pass = {
      setPipeline() {}, setBindGroup() {}, setVertexBuffer() {},
      draw(...args: number[]) { draws.push(args); },
    } as unknown as GPURenderPassEncoder;
    const render = (camera: [number, number, number]) => pipeline.render(
      pass, new Float32Array(16), 800, 600, [1, 0, 0], [0, 1, 0], 14, new Float32Array(16), camera,
    );

    render([0, 0, 0]);
    assert.deepStrictEqual(draws, [[4, 1, 0, 0], [4, 1, 0, 2]], 'the far instance is left out of every run');

    draws.length = 0;
    render([750_000, 0, 0]);
    assert.deepStrictEqual(draws, [[4, 3, 0, 0]], 'all three draw as one run when in range');

    draws.length = 0;
    pipeline.render(pass, new Float32Array(16), 800, 600, [1, 0, 0], [0, 1, 0]);
    assert.deepStrictEqual(draws, [[4, 3, 0, 0]], 'the legacy projection draws every instance');
  });
});

describe('SymbolicTextPipeline glyph halo margin (#5388)', () => {
  it('widens each glyph quad and its UVs by the halo margin without moving the glyph', () => {
    const { device, writes } = makeDevice();
    const pipeline = new SymbolicTextPipeline(device, 'bgra8unorm', 1, makeAtlas());
    // Non-anchored, bottom-left: the quad origin is plain world coordinates.
    pipeline.upload([{
      worldPos: [10, 2, 30], dirX: 1, dirZ: 0,
      height: 0.48, content: 'A', alignment: 'bottom-left',
    }]);
    const pass = { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, draw() {} } as unknown as GPURenderPassEncoder;
    pipeline.render(pass, new Float32Array(16).fill(1), 800, 600, [1, 0, 0], [0, 1, 0]);
    const inst = writes.find((write) => write.length === 27);
    assert.ok(inst, 'the text instance was uploaded');

    const wScale = 0.48 / 48; // world metres per atlas px
    // The glyph's own atlas rect starts at u0 = 0, so the uploaded u0 is minus
    // the halo margin in UV units (makeAtlas().atlasSize is 64).
    const uvMargin = -inst[9];
    const haloAtlasPx = uvMargin * 64;
    assert.ok(haloAtlasPx >= 2, `the quad carries a halo margin (got ${haloAtlasPx} atlas px)`);
    const margin = haloAtlasPx * wScale;
    // The quad is the glyph rect grown by the margin on every side...
    assert.ok(Math.abs(inst[3] - (12 * wScale + 2 * margin)) < 1e-6, `quad width ${inst[3]}`);
    assert.ok(Math.abs(inst[7] - (24 * wScale + 2 * margin)) < 1e-6, `quad height ${inst[7]}`);
    // ...so the glyph itself still starts at the pen position (10 m).
    assert.ok(Math.abs(inst[0] + margin - 10) < 1e-5, `glyph left edge moved to ${inst[0] + margin}`);
    // UVs grow by the same margin in atlas space, so texels still map 1:1.
    const [u0, v0, u1, v1] = [inst[9], inst[10], inst[11], inst[12]];
    assert.ok(Math.abs(u0 + uvMargin) < 1e-6 && Math.abs(v0 + uvMargin) < 1e-6, `uv min ${u0},${v0}`);
    assert.ok(Math.abs(u1 - (0.25 + uvMargin)) < 1e-6 && Math.abs(v1 - (0.25 + uvMargin)) < 1e-6, `uv max ${u1},${v1}`);
  });
});
