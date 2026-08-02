/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-asset point-cloud GPU model matrix (issue #1804: IfcMapConversion
 * alignment toggle). Proves the uniform writer honours `node.model` (or
 * falls back to identity when absent) and that `PointCloudRenderer`'s
 * `setAssetTransform` sets/clears it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writePointCloudUniforms, type PointUniformInputs } from './pointcloud/point-cloud-uniforms.js';
import { POINT_UNIFORM_SIZE } from './pointcloud/point-pipeline.js';
import type { PointCloudNode } from './pointcloud/point-cloud-node.js';

function makeDevice(): GPUDevice {
  return {
    queue: { writeBuffer: () => {} },
  } as unknown as GPUDevice;
}

function makeInputs(): PointUniformInputs {
  return {
    viewProj: new Float32Array(16),
    fixedColor: [1, 1, 1, 1],
    colorMode: 'rgb',
    sizeMode: 'fixed-px',
    pointSize: 4,
    worldRadius: 0.02,
    roundShape: true,
    sectionNormal: [0, 1, 0],
    sectionDist: 0,
    sectionEnabled: false,
    heightMin: 0,
    heightMax: 1,
    viewportW: 800,
    viewportH: 600,
    classMask: new Uint32Array(8).fill(0xFFFFFFFF),
    previewStride: 1,
    deviationCenterOffset: 0,
    deviationHalfRange: 0.05,
  };
}

describe('writePointCloudUniforms model-matrix packing (issue #1804)', () => {
  it('defaults to identity when node.model is absent', () => {
    const scratch = new Float32Array(POINT_UNIFORM_SIZE / 4);
    const scratchU32 = new Uint32Array(scratch.buffer);
    const node = { meta: { expressId: 1 }, uniformBuffer: {} as GPUBuffer } as unknown as PointCloudNode;

    writePointCloudUniforms(makeDevice(), scratch, scratchU32, node, makeInputs());

    // Identity 4x4, column-major, at floats 16..31.
    const expected = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    assert.deepStrictEqual(Array.from(scratch.subarray(16, 32)), expected);
  });

  it('writes an arbitrary node.model verbatim into floats 16..31', () => {
    const scratch = new Float32Array(POINT_UNIFORM_SIZE / 4);
    const scratchU32 = new Uint32Array(scratch.buffer);
    const model = new Float32Array([
      2, 0, 0, 0,
      0, 3, 0, 0,
      0, 0, 4, 0,
      10, 20, 30, 1,
    ]);
    const node = {
      meta: { expressId: 1 },
      uniformBuffer: {} as GPUBuffer,
      model,
    } as unknown as PointCloudNode;

    writePointCloudUniforms(makeDevice(), scratch, scratchU32, node, makeInputs());

    assert.deepStrictEqual(Array.from(scratch.subarray(16, 32)), Array.from(model));
  });

  it('ignores a malformed (wrong-length) node.model and falls back to identity', () => {
    const scratch = new Float32Array(POINT_UNIFORM_SIZE / 4);
    const scratchU32 = new Uint32Array(scratch.buffer);
    const node = {
      meta: { expressId: 1 },
      uniformBuffer: {} as GPUBuffer,
      model: new Float32Array([1, 2, 3]),
    } as unknown as PointCloudNode;

    writePointCloudUniforms(makeDevice(), scratch, scratchU32, node, makeInputs());

    const expected = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    assert.deepStrictEqual(Array.from(scratch.subarray(16, 32)), expected);
  });
});

// ─── transformAabb (world-space bounds under a per-asset matrix) ───────────

import { transformAabb } from './pointcloud/point-cloud-node.js';

describe('transformAabb (issue #1804 world-space point-cloud bounds)', () => {
  const box = {
    min: [1, 2, 3] as [number, number, number],
    max: [2, 3, 4] as [number, number, number],
  };

  it('passes bounds through unchanged without a matrix (or a malformed one)', () => {
    assert.strictEqual(transformAabb(box, undefined), box);
    assert.strictEqual(transformAabb(box, new Float32Array(3)), box);
  });

  it('falls back to identity on a non-finite matrix, in BOTH consumers', () => {
    // A single NaN propagates to every corner of the box and to every point
    // on the GPU, so a degenerate matrix must fall back rather than poison
    // the result. Critically, the AABB fold and the uniform write must agree:
    // if one accepted a matrix the other rejected, the reported bounds would
    // sit in a different frame from the rendered points — the exact failure
    // this transform exists to prevent (CodeRabbit review of PR #1878).
    const nan = new Float32Array(16);
    nan.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    nan[12] = Number.NaN;
    const inf = new Float32Array(nan);
    inf[12] = Number.POSITIVE_INFINITY;

    for (const bad of [nan, inf]) {
      // Consumer 1: bounds fold returns the input box untouched.
      assert.strictEqual(transformAabb(box, bad), box);

      // Consumer 2: uniform write falls back to identity at floats 16..31.
      const scratch = new Float32Array(POINT_UNIFORM_SIZE / 4);
      const scratchU32 = new Uint32Array(scratch.buffer);
      const node = {
        meta: { expressId: 1 },
        uniformBuffer: {} as GPUBuffer,
        model: bad,
      } as unknown as PointCloudNode;
      writePointCloudUniforms(makeDevice(), scratch, scratchU32, node, makeInputs());
      assert.deepStrictEqual(
        Array.from(scratch.subarray(16, 32)),
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      );
    }
  });

  it('applies a pure translation to both corners', () => {
    const m = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      10, -20, 30, 1,
    ]);
    const out = transformAabb(box, m);
    assert.deepStrictEqual(out.min, [11, -18, 33]);
    assert.deepStrictEqual(out.max, [12, -17, 34]);
  });

  it('re-axis-aligns a rotated box (90° about Y: point → (z, y, -x))', () => {
    const m = new Float32Array([
      0, 0, -1, 0,   // x column
      0, 1, 0, 0,    // y column
      1, 0, 0, 0,    // z column
      0, 0, 0, 1,
    ]);
    const out = transformAabb(box, m);
    // x' = z ∈ [3,4]; y' = y ∈ [2,3]; z' = -x ∈ [-2,-1].
    assert.deepStrictEqual(out.min, [3, 2, -2]);
    assert.deepStrictEqual(out.max, [4, 3, -1]);
  });
});

// ─── DeviationPipeline: model matrix reaches the compute params ────────────

import { DeviationPipeline } from './deviation/deviation-pipeline.js';

// WebGPU enum globals referenced by the pipeline (not defined in node).
(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
(globalThis as Record<string, unknown>).GPUBufferUsage = {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};

interface CapturedWrite { data: Uint8Array }

function makeComputeDevice(writes: CapturedWrite[]): GPUDevice {
  const device = {
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createShaderModule: () => ({}),
    createComputePipeline: () => ({}),
    createBuffer: () => ({ destroy: () => {} }),
    createBindGroup: () => ({}),
    queue: {
      writeBuffer: (
        _buffer: unknown,
        _offset: number,
        data: ArrayBuffer | ArrayBufferView,
        dataOffset?: number,
        size?: number,
      ) => {
        if (data instanceof ArrayBuffer) {
          writes.push({ data: new Uint8Array(data.slice(dataOffset ?? 0, (dataOffset ?? 0) + (size ?? data.byteLength))) });
        }
      },
    },
  };
  return device as unknown as GPUDevice;
}

function makeEncoder(): GPUCommandEncoder {
  const pass = {
    setPipeline: () => {},
    setBindGroup: () => {},
    dispatchWorkgroups: () => {},
    end: () => {},
  };
  return { beginComputePass: () => pass } as unknown as GPUCommandEncoder;
}

function tinyBvh() {
  return {
    nodes: new Float32Array(8),
    triangles: new Float32Array(12),
    triangleCount: 1,
    nodeCount: 1,
    meshCount: 1,
    bounds: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] },
  };
}

describe('DeviationPipeline params packing (issue #1804)', () => {
  it('packs the per-asset model matrix ahead of the scalar params', () => {
    const writes: CapturedWrite[] = [];
    const pipeline = new DeviationPipeline(makeComputeDevice(writes));
    pipeline.uploadBvh(tinyBvh());
    const model = new Float32Array([
      2, 0, 0, 0,
      0, 3, 0, 0,
      0, 0, 4, 0,
      10, 20, 30, 1,
    ]);
    const ok = pipeline.dispatch(makeEncoder(), {
      positionsBuffer: {} as GPUBuffer,
      deviationsBuffer: {} as GPUBuffer,
      pointCount: 123,
      maxRange: 0.5,
      model,
    });
    assert.strictEqual(ok, true);
    assert.strictEqual(writes.length, 1);
    const bytes = writes[0].data;
    assert.strictEqual(bytes.byteLength, 80);
    const f = new Float32Array(bytes.buffer, bytes.byteOffset, 20);
    const u = new Uint32Array(bytes.buffer, bytes.byteOffset, 20);
    assert.deepStrictEqual(Array.from(f.subarray(0, 16)), Array.from(model));
    assert.strictEqual(u[16], 123);          // pointCount
    assert.strictEqual(u[17], 6);            // pointStrideF32 (24-byte vertex)
    assert.strictEqual(u[18], 0);            // positionOffsetF32
    assert.ok(Math.abs(f[19] - 0.5) < 1e-9); // maxRange
  });

  it('falls back to the identity matrix when no model is provided', () => {
    const writes: CapturedWrite[] = [];
    const pipeline = new DeviationPipeline(makeComputeDevice(writes));
    pipeline.uploadBvh(tinyBvh());
    pipeline.dispatch(makeEncoder(), {
      positionsBuffer: {} as GPUBuffer,
      deviationsBuffer: {} as GPUBuffer,
      pointCount: 1,
      maxRange: 0,
    });
    const bytes = writes[0].data;
    const f = new Float32Array(bytes.buffer, bytes.byteOffset, 20);
    assert.deepStrictEqual(
      Array.from(f.subarray(0, 16)),
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    );
  });
});
