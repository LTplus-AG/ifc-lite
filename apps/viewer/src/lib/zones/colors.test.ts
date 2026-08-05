/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { zoneColorForIndex } from './colors.js';

function assertClose(actual: number, expected: number, tol = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${actual} to be within ${tol} of ${expected}`,
  );
}

describe('zoneColorForIndex', () => {
  it('returns a valid RGB triple in [0, 1] for every channel', () => {
    for (let i = 0; i < 20; i++) {
      const [r, g, b] = zoneColorForIndex(i);
      for (const c of [r, g, b]) {
        assert.ok(c >= 0 && c <= 1, `channel ${c} out of [0,1] at index ${i}`);
      }
    }
  });

  it('is deterministic — same index always yields the same colour', () => {
    assert.deepStrictEqual(zoneColorForIndex(3), zoneColorForIndex(3));
  });

  it('wraps the 8-colour palette (index 8 matches index 0)', () => {
    assert.deepStrictEqual(zoneColorForIndex(0), zoneColorForIndex(8));
    assert.deepStrictEqual(zoneColorForIndex(1), zoneColorForIndex(9));
  });

  it('assigns visibly distinct colours to adjacent zones (hue actually varies)', () => {
    // Palette hues are 210, 25, 140, 280, ... — indices 0 and 1 must differ
    // by more than a rounding epsilon in at least one channel. This pins the
    // hue-lookup wiring: a mutation that always used hue index 0 would make
    // every zone the same colour and only this assertion would catch it.
    const c0 = zoneColorForIndex(0);
    const c1 = zoneColorForIndex(1);
    const maxDiff = Math.max(...c0.map((v, idx) => Math.abs(v - c1[idx])));
    assert.ok(maxDiff > 0.05, `expected index 0 and 1 to differ, got ${c0} vs ${c1}`);
  });

  it('matches the known RGB for hue 210 (index 0) at s=0.65, l=0.55', () => {
    // Hand-computed reference for HSL(210, 0.65, 0.55) -> RGB.
    // c = (1 - |2*0.55-1|) * 0.65 = 0.9 * 0.65 = 0.585
    // hp = 210/60 = 3.5 -> branch [0, x, c], x = c*(1-|3.5%2 - 1|) = c*(1-0.5)=0.2925
    // m = l - c/2 = 0.55 - 0.2925 = 0.2575
    // r = 0 + m = 0.2575, g = x + m = 0.55, b = c + m = 0.8425
    const [r, g, b] = zoneColorForIndex(0);
    assertClose(r, 0.2575, 1e-4);
    assertClose(g, 0.55, 1e-4);
    assertClose(b, 0.8425, 1e-4);
  });
});
