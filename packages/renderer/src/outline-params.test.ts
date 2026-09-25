/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OUTLINE_SEARCH_RADIUS,
  OUTLINE_WIDTH_PX,
  outlineCoverage,
  HOVER_OUTLINE_COLOR,
  HOVER_VISIBLE_ALPHA,
  OUTLINE_UNIFORM_BYTES,
  OUTLINE_UNIFORM_LAYOUT,
  SELECTION_OUTLINE_COLOR,
  SELECTION_VISIBLE_ALPHA,
  packOutlineUniforms,
} from './outline-params.js';

/**
 * The CPU side of the selection/hover outline composite (#5390): the
 * uniform layout `shaders/edges.wgsl.ts`'s `fs_outline` reads.
 */
describe('packOutlineUniforms (#5390)', () => {
  it('writes the viewport size', () => {
    const out = new Float32Array(OUTLINE_UNIFORM_BYTES / 4);
    packOutlineUniforms(out, { width: 1600, height: 1000 });
    const v = OUTLINE_UNIFORM_LAYOUT.viewport;
    assert.equal(out[v], 1600);
    assert.equal(out[v + 1], 1000);
  });

  function approxEqual(got: readonly number[], want: readonly number[]): void {
    got.forEach((g, i) => assert.ok(Math.abs(g - want[i]) < 1e-6, `[${i}] ${g} !~ ${want[i]}`));
  }

  it('writes the selection colour and its visible alpha', () => {
    const out = new Float32Array(OUTLINE_UNIFORM_BYTES / 4);
    packOutlineUniforms(out, { width: 800, height: 500 });
    const c = OUTLINE_UNIFORM_LAYOUT.selectionColor;
    approxEqual(Array.from(out.subarray(c, c + 3)), SELECTION_OUTLINE_COLOR);
    assert.ok(Math.abs(out[c + 3] - SELECTION_VISIBLE_ALPHA) < 1e-6);
  });

  it('writes the hover colour and its (lower) visible alpha', () => {
    const out = new Float32Array(OUTLINE_UNIFORM_BYTES / 4);
    packOutlineUniforms(out, { width: 800, height: 500 });
    const c = OUTLINE_UNIFORM_LAYOUT.hoverColor;
    approxEqual(Array.from(out.subarray(c, c + 3)), HOVER_OUTLINE_COLOR);
    assert.ok(Math.abs(out[c + 3] - HOVER_VISIBLE_ALPHA) < 1e-6);
    assert.ok(HOVER_VISIBLE_ALPHA < SELECTION_VISIBLE_ALPHA, 'hover is a pre-highlight, dimmer than an active selection');
  });
});

/**
 * #5390: the first cut averaged 4 neighbour taps, so a straight mask edge
 * scored 1/4, a 1 px line at ~22 % alpha (visible) and ~9 % (occluded): the
 * outline was there but invisible in a real WebGPU run.
 */
describe('outline ring coverage (#5390)', () => {
  it('fully covers the pixels either side of a straight boundary', () => {
    assert.equal(outlineCoverage(1), 1, 'the pixel next to the boundary');
    assert.ok(outlineCoverage(Math.SQRT2) > 0.5, 'its diagonal neighbour');
  });

  it('fades to nothing within the search radius', () => {
    assert.equal(outlineCoverage(OUTLINE_SEARCH_RADIUS), 0);
    assert.equal(outlineCoverage(Infinity), 0, 'no differing pixel in reach');
    assert.ok(OUTLINE_SEARCH_RADIUS >= OUTLINE_WIDTH_PX + 0.5, 'the search must reach the fade-out');
  });

  it('is the same curve the shader evaluates', async () => {
    const { outlineFragmentSource } = await import('./shaders/edges.wgsl.js');
    const src = outlineFragmentSource();
    assert.match(src, new RegExp(`const OUTLINE_WIDTH_PX: f32 = ${OUTLINE_WIDTH_PX.toFixed(3)};`));
    assert.match(src, /return clamp\(OUTLINE_WIDTH_PX \+ 0\.5 - nearest, 0\.0, 1\.0\);/);
  });
});
