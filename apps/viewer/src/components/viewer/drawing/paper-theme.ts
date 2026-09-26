/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Drawing canvas's paper and ink follow the app theme (#5496): the
 * direct-mode (non-sheet) section view used to paint `#ffffff` regardless of
 * theme, a white slab against the rest of the dark UI. It now reads the same
 * `paper` / `paper-ink` tokens `overlay-theme.ts` already defines and
 * `registerOverlayThemeSync` already publishes for every other overlay.
 *
 * Two things stay theme-INDEPENDENT on purpose, both already true before
 * this change and preserved here rather than "fixed":
 *  - **Sheet mode's paper is always white.** A drawing sheet models a
 *    physical printed page, and white is the paper colour it is printed on
 *    in every theme; only the desk around it (the canvas area outside the
 *    sheet rectangle) follows the theme, so a dark UI does not float a
 *    literal white rectangle on top of more white.
 *  - **"Print preview" forces white paper.** It previews what the export
 *    actually produces (light drafting palette on white), independent of
 *    whatever theme happens to be active on screen.
 *
 * Canvas 2D's `fillStyle` cannot resolve a CSS custom property the way an
 * SVG attribute or a Tailwind class can (`overlayColor()`'s `var(--overlay-*)`
 * strings are for exactly those two consumers) — a 2D context needs a
 * resolved colour string, so this reads the concrete hex straight out of
 * `OVERLAY_PALETTES` instead.
 */

import type { ThemeMode } from '@/store/slices/uiSlice';
import { OVERLAY_PALETTES } from '@/lib/viewport-ui/overlay-theme';

export interface DrawingPaperTheme {
  /** Direct-mode canvas clear colour / cut-polygon default fill background. */
  paper: string;
  /** Default stroke/text colour for direct-mode content (polygon outlines,
   *  projection/silhouette/crease/boundary/annotation lines). */
  ink: string;
  /** True when {@link paper} is dark enough that fills need the dark-paper
   *  analogue (`IFC_TYPE_FILL_COLORS_DARK`) instead of the light drafting
   *  palette. */
  isDark: boolean;
  /** Sheet mode's desk (the canvas area outside the always-white sheet). */
  desk: string;
}

/** Sheet mode's desk colour per theme. Light/colourful keep the original
 *  `#e5e5e5` (unchanged look); dark gets a muted, dark desk distinct from
 *  both the pure-white sheet on it and the app's near-black chrome. */
const SHEET_DESK: Readonly<Record<ThemeMode, string>> = {
  light: '#e5e5e5',
  dark: '#2a2b3d',
  colorful: '#e5e5e5',
};

const WHITE_PAPER: DrawingPaperTheme = { paper: '#ffffff', ink: '#000000', isDark: false, desk: SHEET_DESK.light };

/**
 * Resolve the paper/ink the Drawing canvas should use right now.
 * `printPreview` always wins: it previews the export (white paper, black
 * ink), whatever `theme` is active.
 */
export function resolveDrawingPaperTheme(theme: ThemeMode, printPreview: boolean): DrawingPaperTheme {
  if (printPreview) return WHITE_PAPER;
  const palette = OVERLAY_PALETTES[theme];
  const paper = palette.paper;
  const isDark = paper.toLowerCase() !== '#ffffff';
  return { paper, ink: palette['paper-ink'], isDark, desk: SHEET_DESK[theme] };
}
