/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Theme ink for IfcAnnotation text.
 *
 * An unstyled label falls back to near-black inside the renderer, and an
 * authored dark colour stays dark whatever the theme, so text keeps an
 * authored colour where it is legible, and is otherwise pulled toward the
 * theme ink just far enough to reach {@link MIN_TEXT_CONTRAST} against the
 * backdrop, which keeps the hue for colours that are merely too dark.
 *
 * The matching LINE colour (every overlay line channel — annotation,
 * alignment, grid, DXF, LandXML — and the section-cut outline, #5388) is no
 * longer computed here: `Renderer.setOverlayTheme`'s `overlayLine` field
 * (#5484) now sources it straight from the `overlay-ink` design token via
 * `rendererOverlayTheme` (`lib/viewport-ui/overlay-theme-renderer.ts`).
 */

import type { ThemeMode } from '@/store/slices/uiSlice';
import { getThemeClearColor } from '@/utils/viewportUtils';

type Rgba = [number, number, number, number];

/** WCAG 2 minimum for large text and graphics (SC 1.4.11). Labels are drawn
 *  at a fixed screen size well above body text, so this is the right floor. */
const MIN_TEXT_CONTRAST = 3;

// Light-theme values are exactly the renderer's own defaults, so the light
// and colorful themes look the same as before this module existed.
const DARK_INK_ON_LIGHT_TEXT: Rgba = [0.05, 0.05, 0.05, 1];
/** Soft off-white, the viewer's dark-theme foreground family. */
const LIGHT_INK_ON_DARK: Rgba = [0.86, 0.88, 0.93, 1];

/** The colour actually behind the overlay. The colorful theme clears to
 *  transparent and shows the page's CSS backdrop (#dde3f0, index.css). */
function annotationBackdrop(theme: ThemeMode): [number, number, number] {
  if (theme === 'colorful') return [0xdd / 255, 0xe3 / 255, 0xf0 / 255];
  const [r, g, b] = getThemeClearColor(theme);
  return [r, g, b];
}

function isDarkBackdrop(theme: ThemeMode): boolean {
  return relativeLuminance(annotationBackdrop(theme)) < 0.18;
}

/** Fallback colour for a label the file does not style. */
function annotationTextInk(theme: ThemeMode): Rgba {
  return isDarkBackdrop(theme) ? LIGHT_INK_ON_DARK : DARK_INK_ON_LIGHT_TEXT;
}

/** WCAG 2 relative luminance of an sRGB colour with 0..1 channels. */
function relativeLuminance([r, g, b]: readonly number[]): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio between two sRGB colours (1..21). */
function contrastRatio(a: readonly number[], b: readonly number[]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The colour to draw a label in under `theme`: the theme ink when the file
 * sets none; the authored colour when it already clears the contrast floor;
 * otherwise the authored colour mixed toward the theme ink by the smallest
 * amount that clears it. Alpha is kept as authored.
 */
export function legibleAnnotationTextColor(color: readonly number[] | undefined, theme: ThemeMode): Rgba {
  const ink = annotationTextInk(theme);
  if (!color) return ink;
  const backdrop = annotationBackdrop(theme);
  const alpha = color[3] ?? 1;
  const authored: Rgba = [color[0], color[1], color[2], alpha];
  if (contrastRatio(authored, backdrop) >= MIN_TEXT_CONTRAST) return authored;
  const mix = (t: number): Rgba => [
    color[0] + (ink[0] - color[0]) * t,
    color[1] + (ink[1] - color[1]) * t,
    color[2] + (ink[2] - color[2]) * t,
    alpha,
  ];
  // Bisect for a small passing mix. `hi` passes at every step (the pure ink
  // clears the floor on every theme backdrop), so the result always does too,
  // even for a colour whose contrast does not rise strictly along the mix.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(mix(mid), backdrop) >= MIN_TEXT_CONTRAST) hi = mid;
    else lo = mid;
  }
  return mix(hi);
}
