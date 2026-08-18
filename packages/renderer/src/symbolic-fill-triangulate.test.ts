/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SymbolicFillPipeline, type SymbolicFillInput } from './symbolic-overlay-pipelines.js';

// WebGPU enum globals referenced by the pipeline's bind-group visibility and
// buffer usage flags (not defined in node) — same polyfill as
// section-2d-overlay-lifecycle.test.ts.
(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
(globalThis as Record<string, unknown>).GPUColorWrite = {
  RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15,
};
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

/**
 * `IfcAnnotationFillArea` is the SECOND consumer of the shared cut-cap
 * triangulator (issue #2516), and it reaches it down a different road: a flat
 * `points` buffer split into rings by `holesOffsets`, rather than an explicit
 * outer/holes pair. Testing the kernel alone would leave that split — and the
 * even-odd nesting it feeds — unverified, which is exactly how the annotation
 * path could keep rendering a hollow hatch after the cap path was fixed.
 *
 * So this drives the real `SymbolicFillPipeline.upload()` over a fake device
 * and measures the vertex stream it actually writes to the GPU.
 */

const FLOATS_PER_VERTEX = 7; // x, y, z, r, g, b, a

function makeDevice() {
  const writes: Float32Array[] = [];
  const device = {
    limits: {} as unknown as GPUSupportedLimits,
    createBindGroupLayout: () => ({}) as GPUBindGroupLayout,
    createPipelineLayout: () => ({}) as GPUPipelineLayout,
    createShaderModule: (desc: { code: string }) =>
      ({ code: desc.code }) as unknown as GPUShaderModule,
    createRenderPipeline: (desc: unknown) => ({ desc }) as unknown as GPURenderPipeline,
    createBindGroup: () => ({}) as GPUBindGroup,
    createBuffer: (desc: { size: number; usage: number }) =>
      ({ __size: desc.size, __usage: desc.usage, destroy() {} }) as unknown as GPUBuffer,
    queue: {
      writeBuffer: (_buffer: GPUBuffer, _offset: number, data: ArrayBufferView) => {
        writes.push(
          new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
        );
      },
    },
  } as unknown as GPUDevice;
  return { device, writes };
}

function fill(
  points: number[],
  holesOffsets: number[],
  worldY = 0,
): SymbolicFillInput {
  return {
    points: Float32Array.from(points),
    holesOffsets: Uint32Array.from(holesOffsets),
    worldY,
    color: [0.2, 0.5, 0.8, 1],
  };
}

/** Area of the triangle soup the pipeline uploaded, in the fill's own plane. */
function uploadedArea(stream: Float32Array): number {
  let sum = 0;
  for (let v = 0; v + 3 * FLOATS_PER_VERTEX <= stream.length; v += 3 * FLOATS_PER_VERTEX) {
    const ax = stream[v];
    const az = stream[v + 2];
    const bx = stream[v + FLOATS_PER_VERTEX];
    const bz = stream[v + FLOATS_PER_VERTEX + 2];
    const cx = stream[v + 2 * FLOATS_PER_VERTEX];
    const cz = stream[v + 2 * FLOATS_PER_VERTEX + 2];
    sum += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
  }
  return sum;
}

function upload(fills: SymbolicFillInput[]): Float32Array {
  const { device, writes } = makeDevice();
  const pipeline = new SymbolicFillPipeline(device, 'bgra8unorm', 1);
  pipeline.upload(fills);
  assert.ok(pipeline.hasGeometry(), 'pipeline uploaded no geometry at all');
  assert.strictEqual(writes.length, 1, 'exactly one vertex-buffer write per upload');
  return writes[0];
}

const SQUARE_4 = [0, 0, 4, 0, 4, 4, 0, 4];
const HOLE_2 = [1, 1, 1, 3, 3, 3, 3, 1];

describe('SymbolicFillPipeline — IfcAnnotationFillArea holes (#2516)', () => {
  it('subtracts an inner bound from the fill it is nested in', () => {
    const stream = upload([fill([...SQUARE_4, ...HOLE_2], [4])]);
    const area = uploadedArea(stream);
    assert.ok(
      Math.abs(area - 12) < 1e-5,
      `annotation fill uploaded area ${area}; 2 = the #2516 bug, ` +
        `20 = the hole added instead of subtracted, 12 = correct`,
    );
  });

  it('leaves a hole-free fill exactly as it was: 2 triangles, area 16', () => {
    const stream = upload([fill(SQUARE_4, [])]);
    assert.strictEqual(stream.length / FLOATS_PER_VERTEX, 6, 'two triangles');
    assert.ok(Math.abs(uploadedArea(stream) - 16) < 1e-5);
  });

  it('fills an island nested inside an inner bound', () => {
    const outer = [0, 0, 10, 0, 10, 10, 0, 10];
    const hole = [2, 2, 2, 8, 8, 8, 8, 2];
    const island = [4, 4, 4, 6, 6, 6, 6, 4];
    const stream = upload([fill([...outer, ...hole, ...island], [4, 8])]);
    const area = uploadedArea(stream);
    // 100 - 36 + 4. "Every ring after the first is a hole" would give 60.
    assert.ok(Math.abs(area - 68) < 1e-5, `nested annotation fill area was ${area}, expected 68`);
  });

  it('keeps every vertex on the fill plane and carries the colour through', () => {
    const stream = upload([fill([...SQUARE_4, ...HOLE_2], [4], 2.5)]);
    for (let v = 0; v < stream.length; v += FLOATS_PER_VERTEX) {
      assert.strictEqual(stream[v + 1], 2.5, 'worldY must be constant across the fill');
      assert.deepStrictEqual(
        Array.from(stream.slice(v + 3, v + 7)),
        [0.2, 0.5, 0.8, 1].map(Math.fround),
      );
    }
  });

  it('drops a degenerate inner bound without losing the outer fill', () => {
    // A 2-vertex "hole" is not a ring; the outer square must still come out whole.
    const stream = upload([fill([...SQUARE_4, 1, 1, 2, 2], [4])]);
    assert.ok(Math.abs(uploadedArea(stream) - 16) < 1e-5);
  });

  it('accumulates several holed fills into one buffer', () => {
    const shifted = [10, 0, 14, 0, 14, 4, 10, 4, 11, 1, 11, 3, 13, 3, 13, 1];
    const stream = upload([fill([...SQUARE_4, ...HOLE_2], [4]), fill(shifted, [4])]);
    assert.ok(Math.abs(uploadedArea(stream) - 24) < 1e-5);
  });
});
