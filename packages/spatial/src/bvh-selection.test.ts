/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { selectMedian } from './bvh-selection.js';

describe('selectMedian', () => {
  it('bounds adversarial partition work and leaves the exact median partition', () => {
    // The organ-pipe order repeatedly defeats median-of-three quickselect.
    const n = 20_001;
    const values = Array.from({ length: n }, (_, i) => i <= n / 2 ? i : n - i);
    const expected = [...values].sort((a, b) => a - b);
    let comparisons = 0;
    let checkpoints = 0;
    for (const _ of selectMedian(values, 0, n, Math.floor(n / 2), (a, b) => {
      comparisons++;
      return a - b;
    })) checkpoints++;
    const target = Math.floor(n / 2);
    expect(values[target]).toBe(expected[target]);
    expect(values.slice(0, target).every(v => v <= values[target])).toBe(true);
    expect(values.slice(target + 1).every(v => v >= values[target])).toBe(true);
    expect(values.slice().sort((a, b) => a - b)).toEqual(expected);
    expect(comparisons).toBeLessThan(1_000_000);
    expect(checkpoints).toBeGreaterThan(0);
  });

  it('respects subarray boundaries, equal keys, and 1024-item checkpoints', () => {
    const values = [999, ...Array.from({ length: 1025 }, (_, i) => 1024 - i), -999];
    const start = 1, end = values.length - 1, target = 1 + 512;
    for (const _ of selectMedian(values, start, end, target, (a, b) => a - b)) { /* drain */ }
    expect(values[0]).toBe(999);
    expect(values.at(-1)).toBe(-999);
    expect(values[target]).toBe(512);
    const equal = Array(2049).fill(7);
    for (const _ of selectMedian(equal, 0, equal.length, 1024, (a, b) => a - b)) { /* drain */ }
    expect(equal).toEqual(Array(2049).fill(7));
  });
});
