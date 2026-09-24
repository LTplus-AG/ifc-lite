/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #5388: IfcAnnotation labels stayed near-black in the dark theme. An
// unstyled label fell back to the renderer's [0.05,0.05,0.05] and an authored
// dark colour was passed through untouched, both invisible on the dark clear
// colour. The invariant: every label the 3D channel emits clears 3:1 contrast
// against the backdrop of the active theme, an authored colour that already
// does is kept as authored, and the light theme keeps the renderer's defaults.
//
// Contrast is computed here rather than imported, so this file only enters
// production through the pre-existing `buildSymbolicRichChannels` seam.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSymbolicRichChannels } from './symbolic-rich-channels.js';
import { buildParseResult, createEmptyFlatSymbolic, type ParseResult } from '../lib/overlay-parse/symbolic-parse.js';

type Rgba = [number, number, number, number];

/** The colour behind the overlay per theme: the WebGPU clear colours, and the
 *  colorful theme's CSS page backdrop (#dde3f0), which its transparent clear shows. */
const BACKDROP = {
  light: [0.96, 0.96, 0.97],
  dark: [0.102, 0.106, 0.149],
  colorful: [0xdd / 255, 0xe3 / 255, 0xf0 / 255],
} as const;

function luminance([r, g, b]: readonly number[]): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: readonly number[], b: readonly number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Three loose annotation labels: unstyled, authored black, authored legible red. */
const AUTHORED: (Rgba | null)[] = [null, [0, 0, 0, 1], [0.9, 0.2, 0.1, 1]];
function parse(): ParseResult {
  const f = createEmptyFlatSymbolic();
  f.typeNames = ['IfcAnnotation'];
  const n = AUTHORED.length;
  f.textContent = AUTHORED.map((_, i) => `L${i}`);
  f.textAlignment = AUTHORED.map(() => 'bottom-left');
  f.textX = Float32Array.from(AUTHORED.map((_, i) => i));
  f.textY = new Float32Array(n);
  f.textDirX = new Float32Array(n).fill(1);
  f.textDirY = new Float32Array(n);
  f.textHeight = new Float32Array(n).fill(0.3);
  f.textTargetPx = new Float32Array(n);
  // Alpha 0 means "not styled by the file".
  f.textColor = Float32Array.from(AUTHORED.flatMap((c) => c ?? [0, 0, 0, 0]));
  f.textOwner = Uint32Array.from(AUTHORED.map((_, i) => 20 + i));
  f.textWorldY = new Float32Array(n).fill(NaN);
  f.textType = new Uint16Array(n);
  return buildParseResult(f, {});
}

function labels(theme: 'light' | 'dark' | 'colorful') {
  return buildSymbolicRichChannels([{ cached: parse() }], {
    enabled: true, effectiveGridEnabled: false, clipEnabled: false, clipPos: 0, clipDepth: 1, fallbackY: 0, theme,
  }).texts;
}

describe('3D annotation label colours follow the theme (#5388)', () => {
  for (const theme of ['light', 'dark', 'colorful'] as const) {
    it(`${theme}: every label clears 3:1 against the backdrop`, () => {
      const texts = labels(theme);
      assert.equal(texts.length, AUTHORED.length, 'the fixture reaches the 3D channel');
      for (const t of texts) {
        assert.ok(t.color, `${t.content} is uploaded with an explicit colour`);
        const ratio = contrast(t.color, BACKDROP[theme]);
        assert.ok(ratio >= 3, `${t.content} ${JSON.stringify(t.color)} on ${theme}: ${ratio.toFixed(2)}:1`);
      }
    });
  }

  it('dark: an authored legible colour is kept exactly', () => {
    assert.deepEqual(labels('dark')[2].color, [0.9, 0.2, 0.1, 1].map(Math.fround));
  });

  it('light: unstyled labels keep the renderer default and authored black stays black', () => {
    const [unstyled, black] = labels('light');
    assert.deepEqual(unstyled.color, [0.05, 0.05, 0.05, 1]);
    assert.deepEqual(black.color, [0, 0, 0, 1]);
  });
});
