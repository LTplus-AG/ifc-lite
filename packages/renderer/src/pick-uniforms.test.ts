/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the picker uniform packing. The layout + flag bits MUST match the
 * WGSL `Uniforms` struct in `picker.ts` and the main render's section/clip
 * discards, otherwise cropped/sectioned geometry stays pickable (or the wrong
 * geometry gets clipped). clipFlags is a u32 view aliasing float lanes 28-31.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { packPickUniforms } from './pick-uniforms.js';
import type { PickClipState } from './types.js';

function fresh(): { out: Float32Array; flags: Uint32Array } {
  const out = new Float32Array(32);
  const flags = new Uint32Array(out.buffer, 112, 4); // byte 112 = float lane 28
  return { out, flags };
}

const VP = Float32Array.from({ length: 16 }, (_, i) => i + 1);

describe('packPickUniforms', () => {
  it('copies viewProj into lanes 0-15', () => {
    const { out, flags } = fresh();
    packPickUniforms(VP, null, out, flags);
    assert.deepStrictEqual([...out.slice(0, 16)], [...VP]);
  });

  it('no clip: section lanes zeroed and all flag bits clear', () => {
    const { out, flags } = fresh();
    packPickUniforms(VP, null, out, flags);
    assert.strictEqual(flags[0], 0);
    assert.deepStrictEqual([...out.slice(16, 28)], new Array(12).fill(0));
  });

  it('section plane: writes normal+distance at 24-27 and sets bit 0', () => {
    const { out, flags } = fresh();
    const clip: PickClipState = {
      sectionPlane: { normal: [0, 1, 0], distance: 2.5, flipped: false },
    };
    packPickUniforms(VP, clip, out, flags);
    assert.deepStrictEqual([...out.slice(24, 28)], [0, 1, 0, 2.5]);
    assert.strictEqual(flags[0] & 1, 1, 'sectionEnabled');
    assert.strictEqual(flags[0] & 2, 0, 'not flipped');
    assert.strictEqual(flags[0] & 4, 0, 'no clip box');
  });

  it('flipped section sets bit 1 as well', () => {
    const { out, flags } = fresh();
    packPickUniforms(VP, { sectionPlane: { normal: [1, 0, 0], distance: -3, flipped: true } }, out, flags);
    assert.strictEqual(flags[0] & 1, 1);
    assert.strictEqual(flags[0] & 2, 2);
  });

  it('clip box enabled: writes min/max at 16-23 and sets bit 2', () => {
    const { out, flags } = fresh();
    packPickUniforms(VP, { clipBox: { min: [-1, -2, -3], max: [4, 5, 6], enabled: true } }, out, flags);
    assert.deepStrictEqual([...out.slice(16, 19)], [-1, -2, -3]);
    assert.deepStrictEqual([...out.slice(20, 23)], [4, 5, 6]);
    assert.strictEqual(flags[0] & 4, 4, 'clipBox bit');
    assert.strictEqual(flags[0] & 1, 0, 'no section');
  });

  it('disabled clip box does not set bit 2', () => {
    const { out, flags } = fresh();
    packPickUniforms(VP, { clipBox: { min: [-1, -1, -1], max: [1, 1, 1], enabled: false } }, out, flags);
    assert.strictEqual(flags[0] & 4, 0);
  });

  it('section + clip box together: flags = 1 | 2 | 4 = 7', () => {
    const { out, flags } = fresh();
    const clip: PickClipState = {
      sectionPlane: { normal: [0, 0, 1], distance: 1, flipped: true },
      clipBox: { min: [0, 0, 0], max: [1, 1, 1], enabled: true },
    };
    packPickUniforms(VP, clip, out, flags);
    assert.strictEqual(flags[0], 7);
  });
});
