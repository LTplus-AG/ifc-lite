/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `resolveDrawingPaperTheme` (#5496): the pure decision behind the Drawing
 * canvas's paper/ink. `Drawing2DCanvas.paperTheme.test.tsx` proves the values
 * this function returns actually reach the 2D context; this file pins the
 * decision itself against the tokens it is supposed to read
 * (`OVERLAY_PALETTES`), so a drift in either file is caught at its own layer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OVERLAY_PALETTES } from '@/lib/viewport-ui/overlay-theme';
import { resolveDrawingPaperTheme } from './paper-theme.js';

describe('resolveDrawingPaperTheme (#5496)', () => {
  it('light theme reads the light palette\'s paper/ink tokens', () => {
    const theme = resolveDrawingPaperTheme('light', false);
    assert.equal(theme.paper, OVERLAY_PALETTES.light.paper);
    assert.equal(theme.ink, OVERLAY_PALETTES.light['paper-ink']);
    assert.equal(theme.isDark, false);
  });

  it('dark theme reads the dark palette\'s paper/ink tokens, and flags itself dark', () => {
    const theme = resolveDrawingPaperTheme('dark', false);
    assert.equal(theme.paper, OVERLAY_PALETTES.dark.paper);
    assert.equal(theme.ink, OVERLAY_PALETTES.dark['paper-ink']);
    assert.equal(theme.isDark, true);
    assert.notEqual(theme.paper, resolveDrawingPaperTheme('light', false).paper);
  });

  it('colorful theme is white paper, same as light (not flagged dark)', () => {
    const theme = resolveDrawingPaperTheme('colorful', false);
    assert.equal(theme.paper, OVERLAY_PALETTES.colorful.paper);
    assert.equal(theme.isDark, false);
  });

  it('print preview forces white paper and black ink in every theme', () => {
    for (const mode of ['light', 'dark', 'colorful'] as const) {
      const theme = resolveDrawingPaperTheme(mode, true);
      assert.equal(theme.paper, '#ffffff', `theme=${mode}`);
      assert.equal(theme.ink, '#000000', `theme=${mode}`);
      assert.equal(theme.isDark, false, `theme=${mode}`);
    }
  });

  it('the desk differs between light and dark even though sheet paper never appears here', () => {
    // The desk is what the CANVAS clears to in sheet mode; the sheet's own
    // paper rectangle is hardcoded white in Drawing2DCanvas itself, not part
    // of this type. This just pins that the desk actually follows the theme.
    const light = resolveDrawingPaperTheme('light', false);
    const dark = resolveDrawingPaperTheme('dark', false);
    assert.notEqual(light.desk, dark.desk);
  });

  it('print preview\'s desk matches its white paper (no separate dark desk while previewing)', () => {
    const theme = resolveDrawingPaperTheme('dark', true);
    assert.equal(theme.desk, resolveDrawingPaperTheme('light', false).desk);
  });
});
