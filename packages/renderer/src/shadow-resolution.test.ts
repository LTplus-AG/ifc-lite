/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Auto shadow-map resolution from the device's texture limit (#2670 review):
 * the resolution select carries no artistic intent, so it should default to a
 * size the device can actually allocate rather than a fixed 2048 that either
 * wastes a capable GPU or overshoots a small one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveShadowMapResolution } from './shadow-pass.js';

describe('resolveShadowMapResolution (#2670 review)', () => {
  it('Auto picks 4096 on a discrete GPU (8192+ texture limit)', () => {
    assert.equal(resolveShadowMapResolution(0, 16384), 4096);
    assert.equal(resolveShadowMapResolution(undefined, 8192), 4096);
  });

  it('Auto picks 2048 on a 4096-capped iGPU', () => {
    assert.equal(resolveShadowMapResolution(0, 4096), 2048);
  });

  it('Auto falls back to 1024 when the device limit is small or unknown', () => {
    assert.equal(resolveShadowMapResolution(0, 2048), 1024);
    assert.equal(resolveShadowMapResolution(0, Number.NaN), 1024);
    assert.equal(resolveShadowMapResolution(0, 0), 1024);
  });

  it('honours a manual value that fits the device', () => {
    assert.equal(resolveShadowMapResolution(2048, 8192), 2048);
    assert.equal(resolveShadowMapResolution(4096, 8192), 4096);
    assert.equal(resolveShadowMapResolution(1024, 8192), 1024);
  });

  it('clamps a manual value that exceeds the device limit (createTexture would fail)', () => {
    assert.equal(resolveShadowMapResolution(4096, 2048), 2048);
  });

  it('floors and clamps a fractional or sub-256 manual value to match allocation (#3053)', () => {
    // ShadowPass allocates max(256, floor(res)); the resolver must return the
    // SAME size or texelWorld/texelSize sample at a different resolution.
    assert.equal(resolveShadowMapResolution(1, 8192), 256);
    assert.equal(resolveShadowMapResolution(100, 8192), 256);
    assert.equal(resolveShadowMapResolution(2048.9, 8192), 2048);
  });
});
