/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `expandTriangles` is the one piece of `ClashSolidPipeline` that has no GPU
 * dependency: it turns an indexed mesh + one flat colour into the
 * non-indexed pos+color-per-vertex stream the shared `SYMBOLIC_FILL_WGSL`
 * vertex layout expects (stride 7 floats: xyz + rgba). Pinned directly since
 * the GPU pipeline itself needs a real `GPUDevice` this test env doesn't have.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ClashSolidPipeline, expandTriangles, type ClashSolidInput } from './clash-solid-pipeline.js';

(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1 };
(globalThis as Record<string, unknown>).GPUColorWrite = { ALL: 15 };
(globalThis as Record<string, unknown>).GPUBufferUsage = { COPY_DST: 8, VERTEX: 32, UNIFORM: 64 };

/** Compare through an f32 round-trip: the vertex buffer is Float32Array, so an
 *  input literal like 0.9 legitimately comes back as 0.8999999761581421. */
function assertCloseArray(actual: readonly number[], expected: readonly number[]): void {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    assert.ok(
      Math.abs(actual[i] - Math.fround(expected[i])) < 1e-6,
      `index ${i}: expected ~${expected[i]}, got ${actual[i]}`,
    );
  }
}

describe('expandTriangles', () => {
  it('expands one triangle into 3 vertices of stride 7 (xyz + rgba)', () => {
    const input: ClashSolidInput = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 0.1, 0.85, 1],
    };
    const out = expandTriangles(input);
    assert.equal(out.length, 3 * 7);
    // Vertex 0: position then colour.
    assertCloseArray(Array.from(out.slice(0, 7)), [0, 0, 0, 1, 0.1, 0.85, 1]);
    // Vertex 1.
    assertCloseArray(Array.from(out.slice(7, 14)), [1, 0, 0, 1, 0.1, 0.85, 1]);
    // Vertex 2.
    assertCloseArray(Array.from(out.slice(14, 21)), [0, 1, 0, 1, 0.1, 0.85, 1]);
  });

  it('every vertex of a two-triangle mesh carries the SAME flat colour', () => {
    const input: ClashSolidInput = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      color: [0.2, 0.4, 0.6, 0.9],
    };
    const out = expandTriangles(input);
    assert.equal(out.length, 6 * 7);
    for (let v = 0; v < 6; v += 1) {
      const rgba = Array.from(out.slice(v * 7 + 3, v * 7 + 7));
      assertCloseArray(rgba, [0.2, 0.4, 0.6, 0.9]);
    }
  });

  it('reads positions through the INDEX, not vertex order — a reused vertex expands to two copies', () => {
    // Vertex 0 is shared by both triangles at a different index slot.
    const input: ClashSolidInput = {
      positions: new Float32Array([5, 6, 7, 0, 0, 0, 1, 1, 1, 2, 2, 2]),
      indices: new Uint32Array([1, 0, 2, 1, 2, 3]), // vertex 0 (pos [5,6,7]) used twice
      color: [1, 1, 1, 1],
    };
    const out = expandTriangles(input);
    assert.equal(out.length, 6 * 7);
    // First triangle's first vertex is index 1 -> position [0,0,0].
    assert.deepEqual(Array.from(out.slice(0, 3)), [0, 0, 0]);
    // Second triangle's first vertex is ALSO index 1 -> [0,0,0] again.
    assert.deepEqual(Array.from(out.slice(21, 24)), [0, 0, 0]);
  });

  it('accepts f64 positions (the wasm solid is f64) without losing precision beyond f32 rounding', () => {
    const input: ClashSolidInput = {
      positions: new Float64Array([1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5]),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 0, 0, 1],
    };
    const out = expandTriangles(input);
    assert.deepEqual(Array.from(out.slice(0, 3)), [1.5, 2.5, 3.5]);
  });

  it('does not subtract an explicit local-origin clash stream twice (#5049)', () => {
    const input: ClashSolidInput = {
      positions: new Float32Array([0.01, 0.02, 0, 0.03, 0.02, 0, 0.01, 0.04, 0]),
      origin: [5_000_000.255, 20, -4],
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 0, 0, 1],
    };
    const out = expandTriangles(input);
    assertCloseArray(Array.from(out.slice(0, 3)), [0.01, 0.02, 0]);
    assertCloseArray(Array.from(out.slice(7, 10)), [0.03, 0.02, 0]);
  });

  it('an empty index list yields an empty stream', () => {
    const input: ClashSolidInput = {
      positions: new Float32Array([0, 0, 0]),
      indices: new Uint32Array([]),
      color: [1, 1, 1, 1],
    };
    assert.equal(expandTriangles(input).length, 0);
  });

  it('keeps a 5,000-km centimetre residual through the anchored solid draw (#5049)', () => {
    const writes: Float32Array[] = [];
    const device = {
      createBindGroupLayout: () => ({}) as GPUBindGroupLayout,
      createPipelineLayout: () => ({}) as GPUPipelineLayout,
      createShaderModule: () => ({}) as GPUShaderModule,
      createRenderPipeline: () => ({}) as GPURenderPipeline,
      createBindGroup: () => ({}) as GPUBindGroup,
      createBuffer: () => ({ destroy() {} }) as GPUBuffer,
      queue: {
        writeBuffer(_buffer: GPUBuffer, _offset: number, data: ArrayBufferView) {
          writes.push(new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
        },
      },
    } as unknown as GPUDevice;
    const pipeline = new ClashSolidPipeline(device, 'bgra8unorm', 1);
    pipeline.upload({
      positions: new Float64Array([
        5_000_000.275, 100, -20,
        5_000_000.285, 100, -20,
        5_000_000.275, 100.01, -20,
      ]),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 0, 0, 1],
    });
    const pass = { setPipeline() {}, setBindGroup() {}, setVertexBuffer() {}, draw() {} } as unknown as GPURenderPassEncoder;
    pipeline.render(
      pass,
      new Float32Array(16).fill(1),
      new Float32Array(16).fill(2),
      [5_000_000.25, 100, -20],
    );
    const vertices = writes.find((write) => write.length === 21);
    const uniform = writes.find((write) => write.length === 40);
    assert.ok(vertices, 'the local clash-solid vertex stream was not uploaded');
    assert.ok(uniform, 'the clash-solid RTE draw uniform was not uploaded');
    assert.ok(Math.abs(vertices[7] - 0.01) < 1e-7, `lost local clash edge: ${vertices[7]}`);
    const residual = uniform[32] + uniform[36];
    assert.ok(Math.abs(residual - 0.025) < 1e-7, `lost clash origin residual: ${residual}`);
    assert.equal(uniform[35], 1, 'Float64 clash output must select the RTE shader route');
    assert.equal(uniform[16], 2, 'Float64 clash output must carry the RTE projection');

    pipeline.upload({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 0, 0, 1],
    });
    pipeline.render(pass, new Float32Array(16).fill(3), new Float32Array(16).fill(4), [0, 0, 0]);
    const legacy = writes[writes.length - 1];
    assert.equal(legacy[35], 0, 'legacy Float32 callers must retain the global route');
    assert.equal(legacy[0], 3, 'legacy Float32 callers retain the global projection');
  });

  it('skips, rather than throws for, a solid outside the eye envelope (#6128)', () => {
    let uniformWrites = 0;
    const device = {
      createBindGroupLayout: () => ({}) as GPUBindGroupLayout,
      createPipelineLayout: () => ({}) as GPUPipelineLayout,
      createShaderModule: () => ({}) as GPUShaderModule,
      createRenderPipeline: () => ({}) as GPURenderPipeline,
      createBindGroup: () => ({}) as GPUBindGroup,
      createBuffer: () => ({ destroy() {} }) as GPUBuffer,
      queue: {
        writeBuffer(_buffer: GPUBuffer, _offset: number, data: ArrayBufferView) {
          if (data.byteLength === 40 * 4) uniformWrites += 1;
        },
      },
    } as unknown as GPUDevice;
    const pipeline = new ClashSolidPipeline(device, 'bgra8unorm', 1);
    pipeline.upload({
      positions: new Float64Array([3_000_000, 0, 0, 3_000_001, 0, 0, 3_000_000, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 0, 0, 1],
    });
    const draws: number[] = [];
    const pass = {
      setPipeline() {}, setBindGroup() {}, setVertexBuffer() {},
      draw(count: number) { draws.push(count); },
    } as unknown as GPURenderPassEncoder;
    pipeline.render(pass, new Float32Array(16), new Float32Array(16), [0, 0, 0]);
    assert.deepEqual(draws, []);
    assert.equal(uniformWrites, 0, 'a skipped solid does not upload a partial uniform');

    pipeline.render(pass, new Float32Array(16), new Float32Array(16), [3_000_000, 0, 0]);
    assert.deepEqual(draws, [3], 'the same solid draws once the camera is in range');
  });
});
