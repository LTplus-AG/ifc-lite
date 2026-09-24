/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Publishes the active theme's overlay palette as CSS custom properties on
 * `<html>` (#5483). The `@theme` block in `index.css` maps Tailwind utilities
 * onto these properties, so `stroke-overlay-accent` follows a theme switch
 * without a stylesheet per theme and without duplicating the palette in CSS.
 */

import { useLayoutEffect } from 'react';
import { useViewerStore } from '@/store';
import type { ThemeMode } from '@/store/slices/uiSlice';
import { OVERLAY_PALETTES, OVERLAY_TOKENS, overlayCssVar } from './overlay-theme';

/** Write every overlay token of `theme` onto `root` as `--overlay-*` properties. */
export function applyOverlayTheme(root: HTMLElement, theme: ThemeMode): void {
  const palette = OVERLAY_PALETTES[theme];
  for (const token of OVERLAY_TOKENS) {
    root.style.setProperty(overlayCssVar(token), palette[token]);
  }
}

/**
 * Keep `<html>`'s overlay properties in step with the store's theme. Mount
 * once; a layout effect so the first paint of any overlay already has values.
 */
export function useOverlayThemeSync(): void {
  const theme = useViewerStore((s) => s.theme);
  useLayoutEffect(() => {
    applyOverlayTheme(document.documentElement, theme);
  }, [theme]);
}
