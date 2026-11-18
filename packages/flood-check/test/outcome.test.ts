/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { BAFU_CLASSES } from '../src/bafu/dataset.js';
import { compareLevel } from '../src/check/outcome.js';

const cls = (id: string) => BAFU_CLASSES.find((c) => c.id === id)!;
const EPS = 1e-6;

describe('compareLevel: both sides of every boundary', () => {
  const T = 432.17;
  for (const margin of [0.5, 0]) {
    for (const id of ['depth-0-0.1', 'depth-0.1-0.25']) {
      const c = cls(id);
      const lower = T + c.lowerBound;
      const upper = T + (c.upperBound as number);
      it(`${id}, margin ${margin}`, () => {
        expect(compareLevel(lower - 1, T, c, margin).outcome).toBe('exposed');
        expect(compareLevel(lower, T, c, margin).outcome).toBe('exposed'); // surface is strictly above T + L
        expect(compareLevel(lower + EPS, T, c, margin).outcome).toBe('within-class-range');
        expect(compareLevel(upper + margin, T, c, margin).outcome).toBe('within-class-range'); // touching is not above
        expect(compareLevel(upper + margin + EPS, T, c, margin).outcome).toBe('above-mapped-class-range');
        expect(compareLevel(upper + 100, T, c, Infinity).outcome).toBe('within-class-range'); // margin not sized
      });
    }
  }

  it('an open-ended class can expose but never be shown above', () => {
    const c = cls('depth-gt-0.25');
    expect(compareLevel(T + 0.25, T, c, 0.5).outcome).toBe('exposed');
    expect(compareLevel(T + 0.25 + EPS, T, c, 0.5).outcome).toBe('open-ended-class');
    expect(compareLevel(T + 100, T, c, 0).outcome).toBe('open-ended-class');
  });

  it('a watercourse is open-ended from the terrain up', () => {
    const c = cls('watercourse');
    expect(compareLevel(T, T, c, 0.5).outcome).toBe('exposed');
    expect(compareLevel(T + EPS, T, c, 0.5).outcome).toBe('open-ended-class');
  });

  it('rejects a negative or NaN margin', () => {
    expect(() => compareLevel(500.15, 500, cls('depth-0.1-0.25'), -0.5)).toThrow(RangeError);
    expect(() => compareLevel(500.15, 500, cls('depth-0.1-0.25'), Number.NaN)).toThrow(RangeError);
  });

  it('returns the numbers behind the outcome', () => {
    const r = compareLevel(500.3, 500, cls('depth-0.1-0.25'), 0.5);
    expect(r.surfaceLowerBound).toBeCloseTo(500.1, 9);
    expect(r.surfaceUpperBound).toBeCloseTo(500.25, 9);
    expect(r.levelAboveSurfaceLowerBound).toBeCloseTo(0.2, 9);
    expect(r.levelAboveSurfaceUpperBound).toBeCloseTo(0.05, 9);
    expect(compareLevel(500, 500, cls('depth-gt-0.25'), 0.5).surfaceUpperBound).toBeNull();
  });
});
