/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the clip-box uniform packing. `packClipBox` is the single source of
 * truth shared by `pipeline.updateUniforms` and the renderer's per-mesh /
 * instanced template loops, so the min/max lanes, the zeroed padding + w lanes,
 * and the returned flags bit must stay exactly as `main.wgsl` reads them.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { packClipBox, CLIPBOX_ENABLED_BIT } from './clip-box.js';
import type { ClipBox } from './types.js';

describe('packClipBox', () => {
  const box: ClipBox = { min: [-1, -2, -3], max: [4, 5, 6], enabled: true };

  it('writes min.xyz / max.xyz at the offset and returns the enabled bit', () => {
    const out = new Float32Array(56);
    const bit = packClipBox(box, out, 48);
    assert.strictEqual(bit, CLIPBOX_ENABLED_BIT);
    assert.deepStrictEqual([...out.slice(48, 51)], [-1, -2, -3]);
    assert.deepStrictEqual([...out.slice(52, 55)], [4, 5, 6]);
  });

  it('zeroes the w padding lanes (51 and 55)', () => {
    const out = new Float32Array(56).fill(9);
    packClipBox(box, out, 48);
    assert.strictEqual(out[51], 0);
    assert.strictEqual(out[55], 0);
  });

  it('returns 0 and zeroes the region when disabled', () => {
    const out = new Float32Array(56).fill(7);
    const bit = packClipBox({ ...box, enabled: false }, out, 48);
    assert.strictEqual(bit, 0);
    for (let i = 48; i < 56; i++) assert.strictEqual(out[i], 0, `lane ${i}`);
  });

  it('returns 0 and zeroes the region when null/undefined', () => {
    const out = new Float32Array(56).fill(7);
    assert.strictEqual(packClipBox(null, out, 48), 0);
    assert.strictEqual(packClipBox(undefined, out, 48), 0);
    for (let i = 48; i < 56; i++) assert.strictEqual(out[i], 0, `lane ${i}`);
  });

  it('honours an arbitrary float offset', () => {
    const out = new Float32Array(16);
    packClipBox(box, out, 4);
    assert.deepStrictEqual([...out.slice(4, 7)], [-1, -2, -3]);
    assert.deepStrictEqual([...out.slice(8, 11)], [4, 5, 6]);
    // lanes before the offset stay untouched
    assert.deepStrictEqual([...out.slice(0, 4)], [0, 0, 0, 0]);
  });
});
