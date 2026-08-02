/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { buildClashPairColors, CLASH_COLOR_A, CLASH_COLOR_B } from './clash-colors.js';

describe('buildClashPairColors (#1277/#1339)', () => {
  it('gives the two clashing elements DISTINCT colours', () => {
    const m = buildClashPairColors(10, 20);
    assert.deepEqual(m.get(10), CLASH_COLOR_A);
    assert.deepEqual(m.get(20), CLASH_COLOR_B);
    assert.notDeepEqual(CLASH_COLOR_A, CLASH_COLOR_B, 'A and B must differ — that is the whole fix');
  });

  it('skips an element that did not resolve (null ref)', () => {
    assert.deepEqual([...buildClashPairColors(null, 20).entries()], [[20, CLASH_COLOR_B]]);
    assert.deepEqual([...buildClashPairColors(10, null).entries()], [[10, CLASH_COLOR_A]]);
    assert.equal(buildClashPairColors(null, null).size, 0);
  });

  it('does not overwrite A with B for a degenerate self-clash (same id)', () => {
    const m = buildClashPairColors(5, 5);
    assert.equal(m.size, 1);
    assert.deepEqual(m.get(5), CLASH_COLOR_A);
  });

  it('colours are valid RGBA floats in 0..1', () => {
    for (const c of [CLASH_COLOR_A, CLASH_COLOR_B]) {
      assert.equal(c.length, 4);
      for (const v of c) assert.ok(v >= 0 && v <= 1, `component ${v} out of range`);
    }
  });
});
