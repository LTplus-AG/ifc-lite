/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { dxfTextLineOffset } from './text-layout.js';

const offsets = (lineCount: number, valign: 'baseline' | 'top' | 'middle' | 'bottom') =>
  Array.from({ length: lineCount }, (_, i) => dxfTextLineOffset(i, lineCount, valign, 2));

describe('dxfTextLineOffset', () => {
  it('grows top and baseline blocks down from the insertion point', () => {
    expect(offsets(3, 'top')).toEqual([0, 2.6, 5.2].map((v) => expect.closeTo(v, 12)));
    expect(offsets(3, 'baseline')).toEqual([0, 2.6, 5.2].map((v) => expect.closeTo(v, 12)));
  });

  it('centres middle blocks and grows bottom blocks up to the point', () => {
    expect(offsets(3, 'middle')).toEqual([-2.6, 0, 2.6].map((v) => expect.closeTo(v, 12)));
    expect(offsets(3, 'bottom')).toEqual([-5.2, -2.6, 0].map((v) => expect.closeTo(v, 12)));
  });

  it('never offsets single-line text', () => {
    for (const valign of ['baseline', 'top', 'middle', 'bottom'] as const) {
      expect(Math.abs(dxfTextLineOffset(0, 1, valign, 2))).toBe(0);
    }
  });
});
