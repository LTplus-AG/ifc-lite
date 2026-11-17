/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { dxfTextLineOffset } from './text-layout.js';

const offsets = (lineCount: number, valign: 'baseline' | 'top' | 'middle' | 'bottom') =>
  Array.from({ length: lineCount }, (_, i) => dxfTextLineOffset(i, lineCount, valign, 2));

describe('dxfTextLineOffset', () => {
  it('grows top and baseline blocks down from the insertion point', () => {
    expect(offsets(3, 'top')).toEqual([0, 10 / 3, 20 / 3].map((v) => expect.closeTo(v, 12)));
    expect(offsets(3, 'baseline')).toEqual([0, 10 / 3, 20 / 3].map((v) => expect.closeTo(v, 12)));
  });

  it('centres middle blocks and grows bottom blocks up to the point', () => {
    expect(offsets(3, 'middle')).toEqual([-10 / 3, 0, 10 / 3].map((v) => expect.closeTo(v, 12)));
    expect(offsets(3, 'bottom')).toEqual([-20 / 3, -10 / 3, 0].map((v) => expect.closeTo(v, 12)));
  });

  it('never offsets single-line text', () => {
    for (const valign of ['baseline', 'top', 'middle', 'bottom'] as const) {
      expect(Math.abs(dxfTextLineOffset(0, 1, valign, 2))).toBe(0);
    }
  });
});

describe('dxfTextLineOffset line spacing factor', () => {
  it('scales the 5/3 pitch by the per-entity factor', () => {
    expect(dxfTextLineOffset(1, 2, 'top', 3, 2)).toBeCloseTo(3 * (5 / 3) * 2, 12);
    expect(dxfTextLineOffset(1, 2, 'top', 3, undefined)).toBeCloseTo(5, 12);
  });
});
