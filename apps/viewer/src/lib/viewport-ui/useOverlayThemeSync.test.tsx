/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The sync writes the active theme's palette onto <html> and follows a theme
 * switch (#5483). Read back through getComputedStyle, the same way a
 * `var(--overlay-accent)` in a stylesheet resolves.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import type { ThemeMode } from '@/store/slices/uiSlice';
import { cleanup, render } from '@/test/render.js';
import { OverlayThemeSync } from '@/components/viewport-ui/OverlayThemeSync';
import { OVERLAY_PALETTES, OVERLAY_TOKENS, overlayCssVar } from './overlay-theme';

afterEach(() => {
  cleanup();
  for (const token of OVERLAY_TOKENS) document.documentElement.style.removeProperty(overlayCssVar(token));
});

function published(): Record<string, string> {
  const computed = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const token of OVERLAY_TOKENS) out[token] = computed.getPropertyValue(overlayCssVar(token)).trim();
  return out;
}

function setTheme(theme: ThemeMode): void {
  act(() => {
    useViewerStore.getState().setTheme(theme);
  });
}

describe('useOverlayThemeSync (#5483)', () => {
  it('publishes the light, dark and colourful palettes in turn', () => {
    useViewerStore.setState({ theme: 'light' });
    render(<OverlayThemeSync />);
    assert.deepEqual(published(), { ...OVERLAY_PALETTES.light });

    setTheme('dark');
    assert.deepEqual(published(), { ...OVERLAY_PALETTES.dark });

    setTheme('colorful');
    assert.deepEqual(published(), { ...OVERLAY_PALETTES.colorful });
  });

  it('a switch changes the accent the stylesheet would resolve', () => {
    useViewerStore.setState({ theme: 'light' });
    render(<OverlayThemeSync />);
    const light = published()['overlay-accent'];
    setTheme('dark');
    const dark = published()['overlay-accent'];
    assert.notEqual(light, dark);
    assert.equal(light, '#2e7de9');
    assert.equal(dark, '#7aa2f7');
  });

  it('names the properties under the --overlay-* namespace, once', () => {
    assert.equal(overlayCssVar('overlay-accent'), '--overlay-accent');
    assert.equal(overlayCssVar('axis-x'), '--overlay-axis-x');
    assert.equal(overlayCssVar('paper-ink'), '--overlay-paper-ink');
  });
});
