/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { selectEvictions, MIN_EVICTION_AGE_FRAMES } from './residency.ts';

const MB = 1024 * 1024;
const FRAME = 1000; // current frame, comfortably past the min age

const shell = (key: string, bytes: number, lastDrawnFrame: number) => ({ key, bytes, lastDrawnFrame });

describe('selectEvictions (#1682 phase 3a)', () => {
  it('returns nothing when within budget', () => {
    const shells = [shell('a', 10 * MB, 0)];
    assert.deepStrictEqual(selectEvictions(shells, 10 * MB, 10 * MB, FRAME), []);
    assert.deepStrictEqual(selectEvictions(shells, 5 * MB, 10 * MB, FRAME), []);
  });

  it('evicts least-recently-drawn first, only until the budget is met', () => {
    const shells = [
      shell('recent', 10 * MB, 900),
      shell('oldest', 10 * MB, 1),
      shell('middle', 10 * MB, 500),
    ];
    // 30MB resident, 15MB budget → need 15MB → evict oldest + middle (20MB)
    assert.deepStrictEqual(selectEvictions(shells, 30 * MB, 15 * MB, FRAME), ['oldest', 'middle']);
    // 30MB resident, 25MB budget → 5MB excess → one eviction suffices
    assert.deepStrictEqual(selectEvictions(shells, 30 * MB, 25 * MB, FRAME), ['oldest']);
  });

  it('never evicts batches younger than the minimum idle age', () => {
    const shells = [
      shell('just-left-frustum', 10 * MB, FRAME - 1),
      shell('old', 10 * MB, FRAME - MIN_EVICTION_AGE_FRAMES),
    ];
    // Only 'old' is idle long enough, even though the budget wants both.
    assert.deepStrictEqual(selectEvictions(shells, 20 * MB, 0, FRAME), ['old']);
  });

  it('treats never-drawn (-1) as the coldest candidates', () => {
    const shells = [shell('drawn-once', MB, 10), shell('never-drawn', MB, -1)];
    assert.deepStrictEqual(selectEvictions(shells, 2 * MB, 0, FRAME), ['never-drawn', 'drawn-once']);
  });

  it('honours a custom min age', () => {
    const shells = [shell('a', MB, FRAME - 5)];
    assert.deepStrictEqual(selectEvictions(shells, MB, 0, FRAME, 10), []);
    assert.deepStrictEqual(selectEvictions(shells, MB, 0, FRAME, 5), ['a']);
  });

  it('returns everything eligible when even full eviction cannot meet the budget', () => {
    const shells = [shell('a', MB, 0), shell('b', MB, 1)];
    assert.deepStrictEqual(selectEvictions(shells, 100 * MB, MB, FRAME), ['a', 'b']);
  });
});
