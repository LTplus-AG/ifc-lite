/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { AABB } from '@ifc-lite/clash';
import {
  clashFramingBounds,
  CLASH_CONTEXT_PAD_FACTOR,
  CLASH_CONTEXT_PAD_MIN_M,
} from './clash-framing.js';

const center = (b: AABB): [number, number, number] => [
  (b.min[0] + b.max[0]) / 2,
  (b.min[1] + b.max[1]) / 2,
  (b.min[2] + b.max[2]) / 2,
];

describe('clashFramingBounds (#1466)', () => {
  it('keeps the overlap centre — the camera looks AT the contact, not off to a beam end', () => {
    const box = clashFramingBounds({ min: [10, 20, 30], max: [12, 24, 30.4] });
    assert.deepEqual(center(box), [11, 22, 30.2]);
  });

  it('grows a sizeable overlap by factor * largest-dimension on every side', () => {
    // largest dim = 4 (Y) -> pad = 4 * 0.6 = 2.4 (well above the 0.5 floor)
    const box = clashFramingBounds({ min: [0, 0, 0], max: [1, 4, 2] });
    const pad = 4 * CLASH_CONTEXT_PAD_FACTOR;
    assert.equal(pad, 2.4);
    assert.deepEqual(box.min, [-pad, -pad, -pad]);
    assert.deepEqual(box.max, [1 + pad, 4 + pad, 2 + pad]);
  });

  it('applies the minimum-metre floor so a flush / near-zero-thickness overlap still gets context', () => {
    // A wall-face touch: 0.3 x 0.3 x ~0 -> largest dim 0.3, factor pad 0.18 < 0.5 floor.
    const box = clashFramingBounds({ min: [0, 0, 0], max: [0.3, 0.3, 0.0] });
    const pad = CLASH_CONTEXT_PAD_MIN_M;
    assert.equal(0.3 * CLASH_CONTEXT_PAD_FACTOR < pad, true, 'factor pad must fall below the floor here');
    // The zero-thickness Z axis expands to a real, human-scale span (2 * floor).
    assert.equal(box.max[2] - box.min[2], 2 * pad);
    assert.deepEqual(box.min, [-pad, -pad, -pad]);
    assert.deepEqual(box.max, [0.3 + pad, 0.3 + pad, pad]);
  });

  it('produces a strictly non-degenerate box (min < max on every axis) even for a point overlap', () => {
    const box = clashFramingBounds({ min: [5, 5, 5], max: [5, 5, 5] });
    for (let i = 0; i < 3; i += 1) assert.ok(box.max[i] > box.min[i], `axis ${i} must be non-degenerate`);
    assert.deepEqual(center(box), [5, 5, 5]);
  });

  it('normalises an inverted input box (min/max swapped) instead of producing a negative-size frame', () => {
    const box = clashFramingBounds({ min: [12, 24, 30.4], max: [10, 20, 30] });
    assert.deepEqual(center(box), [11, 22, 30.2]);
    for (let i = 0; i < 3; i += 1) assert.ok(box.max[i] > box.min[i], `axis ${i} must be non-degenerate`);
  });
});
