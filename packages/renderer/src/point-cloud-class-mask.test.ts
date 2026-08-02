/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The 256-bit LAS class-visibility mask (#1783): option normalization
 * and the uniform-block packing contract the splat shader reads
 * (`point-shader.wgsl.ts` classMask cull).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  CLASS_MASK_WORDS,
  normalizeClassMask,
  writePointCloudUniforms,
  type PointUniformInputs,
} from './pointcloud/point-cloud-uniforms.js';
import { POINT_UNIFORM_SIZE } from './pointcloud/point-pipeline.js';
import type { PointCloudNode } from './pointcloud/point-cloud-node.js';

describe('normalizeClassMask (#1783)', () => {
  it('defaults to every class visible', () => {
    const mask = normalizeClassMask(undefined);
    assert.strictEqual(mask.length, CLASS_MASK_WORDS);
    assert.ok(mask.every((w) => w === 0xFFFFFFFF));
  });

  it('keeps legacy 32-bit semantics: classes 32..255 stay visible', () => {
    // Hide class 3 via the old numeric form.
    const mask = normalizeClassMask(~(1 << 3) >>> 0);
    assert.strictEqual(mask[0], ~(1 << 3) >>> 0);
    for (let w = 1; w < CLASS_MASK_WORDS; w++) {
      assert.strictEqual(mask[w], 0xFFFFFFFF, `word ${w} must stay all-visible`);
    }
  });

  it('accepts up to 8 words and defaults missing/invalid words to visible', () => {
    // Hide class 64 (word 2, bit 0); leave words 3..7 unspecified.
    const words = [0xFFFFFFFF, 0xFFFFFFFF, ~1 >>> 0];
    const mask = normalizeClassMask(words);
    assert.strictEqual(mask[2], ~1 >>> 0);
    assert.strictEqual(mask[7], 0xFFFFFFFF);

    const withNaN = normalizeClassMask([Number.NaN, 0]);
    assert.strictEqual(withNaN[0], 0xFFFFFFFF, 'NaN word resets to all-visible');
    assert.strictEqual(withNaN[1], 0);
  });

  it('coerces signed word values into the unsigned 32-bit range', () => {
    const mask = normalizeClassMask([-1, -2]);
    assert.strictEqual(mask[0], 0xFFFFFFFF);
    assert.strictEqual(mask[1], 0xFFFFFFFE);
  });
});

describe('writePointCloudUniforms class-mask packing (#1783)', () => {
  it('writes the 8 mask words at u32 slots 60..67 and zeroes legacy flags.w', () => {
    const scratch = new Float32Array(POINT_UNIFORM_SIZE / 4);
    const scratchU32 = new Uint32Array(scratch.buffer);
    let wroteWords = 0;
    const device = {
      queue: {
        writeBuffer: (
          _buffer: GPUBuffer,
          _offset: number,
          _data: Float32Array,
          _dataOffset?: number,
          size?: number,
        ) => { wroteWords = size ?? 0; },
      },
    } as unknown as GPUDevice;
    const node = {
      meta: { expressId: 42 },
      uniformBuffer: {} as GPUBuffer,
    } as unknown as PointCloudNode;

    // Hide class 2 (word 0) and class 200 (word 6, bit 8).
    const classMask = normalizeClassMask([~(1 << 2) >>> 0, -1, -1, -1, -1, -1, ~(1 << 8) >>> 0, -1]);
    const inputs: PointUniformInputs = {
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
      classMask,
      previewStride: 1,
      deviationCenterOffset: 0,
      deviationHalfRange: 0.05,
    };

    writePointCloudUniforms(device, scratch, scratchU32, node, inputs);

    assert.strictEqual(scratchU32[48], 42, 'flags.x = expressId');
    assert.strictEqual(scratchU32[51], 0, 'flags.w is reserved since the 256-bit mask');
    for (let w = 0; w < CLASS_MASK_WORDS; w++) {
      assert.strictEqual(scratchU32[60 + w], classMask[w], `mask word ${w}`);
    }
    // The full block, including the mask words, must reach the GPU.
    assert.strictEqual(wroteWords, POINT_UNIFORM_SIZE / 4);
  });
});
