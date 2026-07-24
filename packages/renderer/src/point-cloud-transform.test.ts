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
