/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderTargetBytes, textureBytes, type TextureLike } from './render-target-bytes.js';

const tex = (format: GPUTextureFormat, sampleCount = 1, width = 1920, height = 1080): TextureLike =>
  ({ width, height, depthOrArrayLayers: 1, sampleCount, format });

/**
 * Render-target telemetry: what a small model's GPU footprint is made of once
 * geometry is negligible. Numbers are 1920x1080 at DPR 1, 4x MSAA.
 */
describe('render-target bytes', () => {
  it('counts every sample of a multisampled attachment at its format size', () => {
    assert.equal(textureBytes(tex('bgra8unorm', 4)), 1920 * 1080 * 4 * 4);
    assert.equal(textureBytes(tex('rg8unorm')), 1920 * 1080 * 2);
    assert.equal(textureBytes(tex('r8unorm')), 1920 * 1080);
    assert.equal(textureBytes(tex('rg16float')), 1920 * 1080 * 4);
  });

  it('sums owners, skipping unallocated (null) targets, and sizes the square shadow map', () => {
    const msaa = textureBytes(tex('bgra8unorm', 4));
    const bytes = renderTargetBytes({
      main: [tex('depth24plus-stencil8', 4), tex('rgba8unorm', 4), tex('bgra8unorm', 4), null],
      picker: [null, null],
      post: [tex('rg16float'), tex('rg16float')],
      shadowResolution: 2048,
    });
    assert.equal(bytes.main, 3 * msaa);
    assert.equal(bytes.picker, 0, 'a picker that never picked holds nothing');
    assert.equal(bytes.post, 2 * 1920 * 1080 * 4);
    assert.equal(bytes.shadow, 2048 * 2048 * 4);
    assert.equal(bytes.total, bytes.main + bytes.picker + bytes.post + bytes.shadow);
  });

  it('reports zero for an absent owner (no renderer pipeline yet, shadows off)', () => {
    assert.deepEqual(renderTargetBytes({ shadowResolution: null }), { main: 0, picker: 0, post: 0, shadow: 0, total: 0 });
  });
});
