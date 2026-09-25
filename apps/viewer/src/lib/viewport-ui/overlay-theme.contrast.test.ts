/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every overlay token is measured against the backdrop it is drawn on (#5483).
 *
 * Backdrops: the WebGPU clear colour for light and dark (`getThemeClearColor`),
 * and for the colourful theme every stop of its canvas gradient from 32% down,
 * the band the model occupies (the 0-20% sky band is slate blue, luminance
 * 0.11-0.27, and no hue can clear both it and the sand at the bottom).
 *
 * Floors: WCAG 1.4.11 (3:1) for lines, handles and fills; WCAG 1.4.3 (4.5:1)
 * for ink used as label text. Graphics-only tokens are listed by name below;
 * accent-coloured text is set as ink on an accent-bordered label, never as
 * accent text on the canvas.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, type Rgba } from '@/test/contrast/wcag';
import { getThemeClearColor } from '@/utils/viewportUtils';
import type { ThemeMode } from '@/store/slices/uiSlice';
import {
  COLORFUL_CANVAS_GRADIENT_STOPS,
  OVERLAY_PALETTES,
  OVERLAY_TOKENS,
  tokenToLinearRgba,
  tokenToRgba,
  type OverlayToken,
} from './overlay-theme';

const LINE_FLOOR = 3;
const TEXT_FLOOR = 4.5;

function rgba255(value: string): Rgba {
  const [r, g, b, a] = tokenToRgba(value);
  return { r: r * 255, g: g * 255, b: b * 255, a };
}

/** The opaque colours an overlay can land on in `theme`, named for the report. */
function backdrops(theme: ThemeMode): Array<[name: string, color: Rgba]> {
  if (theme === 'colorful') {
    return COLORFUL_CANVAS_GRADIENT_STOPS
      .filter(([, offset]) => offset >= 32)
      .map(([color, offset]) => [`gradient ${offset}% ${color}`, rgba255(color)]);
  }
  const [r, g, b] = getThemeClearColor(theme);
  return [[`clear colour`, { r: r * 255, g: g * 255, b: b * 255, a: 1 }]];
}

function minContrast(theme: ThemeMode, token: OverlayToken): { ratio: number; against: string } {
  const fg = rgba255(OVERLAY_PALETTES[theme][token]);
  let worst = { ratio: Infinity, against: '' };
  for (const [name, bg] of backdrops(theme)) {
    const ratio = contrastRatio(fg, bg);
    if (ratio < worst.ratio) worst = { ratio, against: name };
  }
  return worst;
}

/** Graphics: lines, handles, fills, markers. 3:1 against the canvas. */
const GRAPHICS_TOKENS: OverlayToken[] = [
  'overlay-accent',
  'axis-x', 'axis-y', 'axis-z',
  'status-danger', 'status-warn', 'status-ok', 'status-info',
  'clash-a', 'clash-b', 'clash-overlap',
];

const THEMES: ThemeMode[] = ['light', 'dark', 'colorful'];

describe('overlay palette contrast against the canvas (#5483)', () => {
  for (const theme of THEMES) {
    describe(theme, () => {
      it('overlay-ink clears 4.5:1 as label text on the canvas', () => {
        const { ratio, against } = minContrast(theme, 'overlay-ink');
        assert.ok(ratio >= TEXT_FLOOR, `overlay-ink ${ratio.toFixed(2)}:1 on ${against}`);
      });

      it('overlay-ink-muted clears the text floor where secondary labels sit', () => {
        // Light and dark draw secondary labels straight on the canvas. The
        // colourful canvas is a mid-tone gradient, so its labels always sit on
        // a halo: muted ink is a line there and text only on the halo.
        const { ratio, against } = minContrast(theme, 'overlay-ink-muted');
        const floor = theme === 'colorful' ? LINE_FLOOR : TEXT_FLOOR;
        assert.ok(ratio >= floor, `overlay-ink-muted ${ratio.toFixed(2)}:1 on ${against}`);
        const p = OVERLAY_PALETTES[theme];
        const onHalo = contrastRatio(rgba255(p['overlay-ink-muted']), rgba255(p['overlay-halo']));
        assert.ok(onHalo >= TEXT_FLOOR, `overlay-ink-muted ${onHalo.toFixed(2)}:1 on halo`);
      });

      for (const token of GRAPHICS_TOKENS) {
        it(`${token} clears 3:1 as a line on the canvas`, () => {
          const { ratio, against } = minContrast(theme, token);
          assert.ok(ratio >= LINE_FLOOR, `${token} ${ratio.toFixed(2)}:1 on ${against}`);
        });
      }

      it('ink reads on the halo and the accent outlines it', () => {
        const p = OVERLAY_PALETTES[theme];
        const halo = rgba255(p['overlay-halo']);
        const ink = contrastRatio(rgba255(p['overlay-ink']), halo);
        const accent = contrastRatio(rgba255(p['overlay-accent']), halo);
        assert.ok(ink >= TEXT_FLOOR, `ink on halo ${ink.toFixed(2)}:1`);
        assert.ok(accent >= LINE_FLOOR, `accent on halo ${accent.toFixed(2)}:1`);
      });

      it('paper-ink reads as text on paper', () => {
        const p = OVERLAY_PALETTES[theme];
        const ratio = contrastRatio(rgba255(p['paper-ink']), rgba255(p.paper));
        assert.ok(ratio >= TEXT_FLOOR, `paper-ink on paper ${ratio.toFixed(2)}:1`);
      });

      it('the clash pair is the warn / info / danger status mapping', () => {
        const p = OVERLAY_PALETTES[theme];
        assert.equal(p['clash-a'], p['status-warn']);
        assert.equal(p['clash-b'], p['status-info']);
        assert.equal(p['clash-overlap'], p['status-danger']);
      });

      it('accent-soft is the accent at a wash alpha', () => {
        const p = OVERLAY_PALETTES[theme];
        const [r, g, b, a] = tokenToRgba(p['overlay-accent-soft']);
        const [ar, ag, ab] = tokenToRgba(p['overlay-accent']);
        assert.deepEqual([r, g, b], [ar, ag, ab]);
        assert.ok(a >= 0.12 && a <= 0.24, `accent-soft alpha ${a.toFixed(3)}`);
      });
    });
  }

  it('every theme defines every token as a parseable hex colour', () => {
    for (const theme of THEMES) {
      for (const token of OVERLAY_TOKENS) {
        const [r, g, b, a] = tokenToRgba(OVERLAY_PALETTES[theme][token]);
        for (const c of [r, g, b, a]) assert.ok(c >= 0 && c <= 1, `${theme} ${token}`);
      }
    }
  });
});

describe('token to renderer colour (#5483)', () => {
  it('tokenToRgba keeps the sRGB encoding the clear colour and line uniforms use', () => {
    // #1a1b26 is the dark clear colour; getThemeClearColor spells it as 0.102/0.106/0.149.
    const [r, g, b, a] = tokenToRgba('#1a1b26');
    const [cr, cg, cb] = getThemeClearColor('dark');
    assert.ok(Math.abs(r - cr) < 0.001 && Math.abs(g - cg) < 0.001 && Math.abs(b - cb) < 0.001);
    assert.equal(a, 1);
    assert.deepEqual(tokenToRgba('#ffffff80').map((c) => Number(c.toFixed(3))), [1, 1, 1, 0.502]);
  });

  it('tokenToLinearRgba decodes the gamma curve for the lit pipeline', () => {
    const [r, g, b, a] = tokenToLinearRgba('#7aa2f7');
    // sRGB 122/162/247 → linear 0.195/0.361/0.930 (IEC 61966-2-1); alpha is not encoded.
    assert.ok(Math.abs(r - 0.1946) < 0.001, `r ${r}`);
    assert.ok(Math.abs(g - 0.3613) < 0.001, `g ${g}`);
    assert.ok(Math.abs(b - 0.9301) < 0.001, `b ${b}`);
    assert.equal(a, 1);
    assert.deepEqual(tokenToLinearRgba('#000000'), [0, 0, 0, 1]);
    assert.deepEqual(tokenToLinearRgba('#ffffff'), [1, 1, 1, 1]);
  });

  it('rejects anything but #rrggbb / #rrggbbaa', () => {
    for (const bad of ['#fff', 'rgb(1, 2, 3)', '2e7de9', '#2e7de9ff0']) {
      assert.throws(() => tokenToRgba(bad), /overlay token/);
    }
  });
});
