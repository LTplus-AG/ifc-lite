/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';

import {
  buildClashPairColors, clashColorToBcfArgb,
  CLASH_COLOR_A, CLASH_COLOR_B, CLASH_COLOR_OVERLAP,
  setClashColorsFromTheme,
} from './clash-colors.js';
import { OVERLAY_PALETTES, tokenToRgba } from '@/lib/viewport-ui/overlay-theme';

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

describe('clashColorToBcfArgb (#4806)', () => {
  it('encodes as opaque ARGB hex — the exact 8-char, no-# form BCF <Color> expects', () => {
    assert.equal(clashColorToBcfArgb(CLASH_COLOR_A), 'FFFF800D');
    assert.equal(clashColorToBcfArgb(CLASH_COLOR_B), 'FF00D1FF');
    assert.equal(clashColorToBcfArgb(CLASH_COLOR_OVERLAP), 'FFFF1AD9');
  });

  it('always writes full opacity (leading FF), regardless of the source alpha', () => {
    assert.equal(clashColorToBcfArgb([1, 0, 0, 0]).slice(0, 2), 'FF');
    assert.equal(clashColorToBcfArgb([1, 0, 0, 1]).slice(0, 2), 'FF');
  });

  it('round black and white to the expected extremes', () => {
    assert.equal(clashColorToBcfArgb([0, 0, 0, 1]), 'FF000000');
    assert.equal(clashColorToBcfArgb([1, 1, 1, 1]), 'FFFFFFFF');
  });
});

describe('setClashColorsFromTheme (#5484)', () => {
  // Restore the light-theme (default) values so this file's earlier assertions
  // — and any test file that runs after this one in the same process — see
  // the values they expect, not whatever theme the last test here landed on.
  afterEach(() => setClashColorsFromTheme('light'));

  it('sources the three tints from the clash-a / clash-b / clash-overlap tokens of the given theme', () => {
    for (const theme of ['light', 'dark', 'colorful'] as const) {
      setClashColorsFromTheme(theme);
      const palette = OVERLAY_PALETTES[theme];
      assert.deepEqual(CLASH_COLOR_A, tokenToRgba(palette['clash-a']), `${theme}: clash A`);
      assert.deepEqual(CLASH_COLOR_B, tokenToRgba(palette['clash-b']), `${theme}: clash B`);
      assert.deepEqual(CLASH_COLOR_OVERLAP, tokenToRgba(palette['clash-overlap']), `${theme}: clash overlap`);
    }
  });

  it('mutates the exported arrays IN PLACE — the bindings keep their identity across a theme change', () => {
    const [a, b, overlap] = [CLASH_COLOR_A, CLASH_COLOR_B, CLASH_COLOR_OVERLAP];
    setClashColorsFromTheme('dark');
    // Reference equality, not deepEqual: every `=== CLASH_COLOR_A` comparison
    // elsewhere (group-focus.ts, guid-occurrence-colors.ts) depends on this.
    assert.equal(CLASH_COLOR_A, a, 'CLASH_COLOR_A must stay the same array object');
    assert.equal(CLASH_COLOR_B, b, 'CLASH_COLOR_B must stay the same array object');
    assert.equal(CLASH_COLOR_OVERLAP, overlap, 'CLASH_COLOR_OVERLAP must stay the same array object');
    // ...but its CONTENT did change to the dark palette.
    assert.deepEqual(CLASH_COLOR_A, tokenToRgba(OVERLAY_PALETTES.dark['clash-a']));
  });

  it('a stale reference to the mutated array observes the new colour (that is the point)', () => {
    const map = buildClashPairColors(1, 2);
    const before = map.get(1);
    setClashColorsFromTheme('dark');
    assert.deepEqual(map.get(1), tokenToRgba(OVERLAY_PALETTES.dark['clash-a']));
    assert.equal(map.get(1), before, 'same array reference, refreshed content');
  });
});
