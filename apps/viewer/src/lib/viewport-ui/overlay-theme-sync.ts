/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Publishes the active theme's overlay palette as CSS custom properties on
 * `<html>` (#5483). The `@theme` block in `index.css` maps Tailwind utilities
 * onto these properties, and inline styles read them through `overlayColor`,
 * so `stroke-overlay-accent` follows a theme switch without a stylesheet per
 * theme and without duplicating the palette in CSS.
 *
 * A store subscription, registered once where the store is created
 * (`getViewerStoreApi`), not a component some app has to remember to mount:
 * the embed (`apps/viewer-embed`) renders the viewer's `ViewportOverlays`
 * without the viewer's `App`, and a React mount in `App.tsx` left every
 * `var(--overlay-*)` there resolving to nothing, so the axis triad was
 * transparent (#5490). Whatever holds the store now holds the tokens.
 */

import type { ThemeMode } from '@/store/slices/uiSlice';
import { OVERLAY_PALETTES, OVERLAY_TOKENS, overlayCssVar } from './overlay-theme';

/** Write every overlay token of `theme` onto `root` as `--overlay-*` properties. */
export function applyOverlayTheme(root: HTMLElement, theme: ThemeMode): void {
  const palette = OVERLAY_PALETTES[theme];
  for (const token of OVERLAY_TOKENS) {
    root.style.setProperty(overlayCssVar(token), palette[token]);
  }
}

interface ThemeStore {
  getState: () => { theme: ThemeMode };
  subscribe: (listener: (state: { theme: ThemeMode }, prev: { theme: ThemeMode }) => void) => () => void;
}

/**
 * Publish the store's current theme onto `<html>` now, and again on every
 * theme change, whoever makes it (`setTheme`, `toggleTheme`, a direct
 * `setState`). Synchronous, so the first paint of any overlay already has
 * values. A no-op without a DOM (node-only tests, workers).
 */
export function registerOverlayThemeSync(store: ThemeStore): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  applyOverlayTheme(root, store.getState().theme);
  store.subscribe((state, prev) => {
    if (state.theme !== prev.theme) applyOverlayTheme(root, state.theme);
  });
}
