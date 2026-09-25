/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OVERLAY_PALETTES, tokenToLinearRgba, tokenToRgba } from './overlay-theme.js';
import { rendererOverlayTheme } from './overlay-theme-renderer.js';

describe('rendererOverlayTheme (#5484)', () => {
  it('sources selection from overlay-accent, LINEAR-decoded — the lit pipeline would wash out an sRGB value', () => {
    for (const theme of ['light', 'dark', 'colorful'] as const) {
      const rt = rendererOverlayTheme(theme);
      assert.deepEqual(rt.selection, tokenToLinearRgba(OVERLAY_PALETTES[theme]['overlay-accent']), theme);
      // Not the sRGB-direct reading: that would be a different (brighter, in
      // every one of these themes) number, catching a helper mix-up.
      assert.notDeepEqual(rt.selection, tokenToRgba(OVERLAY_PALETTES[theme]['overlay-accent']), theme);
    }
  });

  it('sources the section-plane accent from the SAME overlay-accent token, sRGB-direct — one tint for every axis', () => {
    for (const theme of ['light', 'dark', 'colorful'] as const) {
      const rt = rendererOverlayTheme(theme);
      assert.deepEqual(rt.sectionPlane, tokenToRgba(OVERLAY_PALETTES[theme]['overlay-accent']), theme);
    }
  });

  it('sources overlay lines from overlay-ink (passive marks are ink, not accent), sRGB-direct', () => {
    for (const theme of ['light', 'dark', 'colorful'] as const) {
      const rt = rendererOverlayTheme(theme);
      assert.deepEqual(rt.overlayLine, tokenToRgba(OVERLAY_PALETTES[theme]['overlay-ink']), theme);
    }
  });

  it('sources the three clash tints from clash-a / clash-b / clash-overlap, sRGB-direct', () => {
    for (const theme of ['light', 'dark', 'colorful'] as const) {
      const rt = rendererOverlayTheme(theme);
      const palette = OVERLAY_PALETTES[theme];
      assert.deepEqual(rt.clashA, tokenToRgba(palette['clash-a']), theme);
      assert.deepEqual(rt.clashB, tokenToRgba(palette['clash-b']), theme);
      assert.deepEqual(rt.clashOverlap, tokenToRgba(palette['clash-overlap']), theme);
    }
  });

  it('every theme produces a genuinely different set of colours (no theme collapses to another)', () => {
    const light = rendererOverlayTheme('light');
    const dark = rendererOverlayTheme('dark');
    const colorful = rendererOverlayTheme('colorful');
    assert.notDeepEqual(light, dark);
    assert.notDeepEqual(light, colorful);
    assert.notDeepEqual(dark, colorful);
  });
});
