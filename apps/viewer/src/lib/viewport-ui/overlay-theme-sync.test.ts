/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The store writes the active theme's palette onto <html> and follows a theme
 * switch (#5483). Read back through getComputedStyle, the same way a
 * `var(--overlay-accent)` in a stylesheet resolves.
 *
 * Nothing is mounted here, on purpose: the sync used to be a component that
 * only the viewer's `App` rendered, so the embed, which renders the viewer's
 * overlays without that `App`, got no tokens at all (#5490). Holding the store
 * is now enough.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import type { ThemeMode } from '@/store/slices/uiSlice';
import { OVERLAY_PALETTES, OVERLAY_TOKENS, overlayCssVar } from './overlay-theme';
import { registerOverlayThemeSync } from './overlay-theme-sync';

function published(root: HTMLElement = document.documentElement): Record<string, string> {
  const computed = getComputedStyle(root);
  const out: Record<string, string> = {};
  for (const token of OVERLAY_TOKENS) out[token] = computed.getPropertyValue(overlayCssVar(token)).trim();
  return out;
}

describe('overlay theme sync (#5483, #5490)', () => {
  it('publishes the light, dark and colourful palettes in turn, with nothing mounted', () => {
    for (const theme of ['light', 'dark', 'colorful', 'light'] as ThemeMode[]) {
      useViewerStore.getState().setTheme(theme);
      assert.deepEqual(published(), { ...OVERLAY_PALETTES[theme] }, theme);
    }
  });

  it('follows a direct setState too, not only the setTheme action', () => {
    useViewerStore.getState().setTheme('light');
    useViewerStore.setState({ theme: 'dark' });
    assert.equal(published()['axis-z'], OVERLAY_PALETTES.dark['axis-z']);
    useViewerStore.getState().setTheme('light');
  });

  it('a switch changes the accent the stylesheet would resolve', () => {
    useViewerStore.getState().setTheme('light');
    const light = published()['overlay-accent'];
    useViewerStore.getState().setTheme('dark');
    const dark = published()['overlay-accent'];
    assert.equal(light, '#2e7de9');
    assert.equal(dark, '#7aa2f7');
    useViewerStore.getState().setTheme('light');
  });

  it('registering publishes the current theme at once, before any change', () => {
    // A fresh store stand-in, so this does not depend on what the real one did
    // at import time.
    let theme: ThemeMode = 'dark';
    const listeners: Array<(s: { theme: ThemeMode }, p: { theme: ThemeMode }) => void> = [];
    for (const token of OVERLAY_TOKENS) document.documentElement.style.removeProperty(overlayCssVar(token));
    registerOverlayThemeSync({
      getState: () => ({ theme }),
      subscribe: (listener) => { listeners.push(listener); return () => {}; },
    });
    assert.deepEqual(published(), { ...OVERLAY_PALETTES.dark });
    const prev = theme;
    theme = 'colorful';
    for (const l of listeners) l({ theme }, { theme: prev });
    assert.deepEqual(published(), { ...OVERLAY_PALETTES.colorful });
    useViewerStore.getState().setTheme('light');
  });

  it('names the properties under the --overlay-* namespace, once', () => {
    assert.equal(overlayCssVar('overlay-accent'), '--overlay-accent');
    assert.equal(overlayCssVar('axis-x'), '--overlay-axis-x');
    assert.equal(overlayCssVar('paper-ink'), '--overlay-paper-ink');
  });
});
