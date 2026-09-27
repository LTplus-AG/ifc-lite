/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Overlay design tokens: the one colour vocabulary for everything drawn over
 * the 3D viewport (#5483, charter #5478).
 *
 * One palette per theme, in TypeScript, so the same values reach three
 * consumers without drifting: CSS custom properties on `<html>` (written by
 * `registerOverlayThemeSync`), Tailwind utilities (`@theme` entries in `index.css`
 * that point at those properties), and the renderer's uniforms
 * (`tokenToRgba` / `tokenToLinearRgba`, consumed by the renderer bridge).
 *
 * The vocabulary is deliberately small. Passive marks are *ink*; the one thing
 * being manipulated is *accent*; nothing else carries a hue unless the hue
 * carries meaning (axis, status). The colours are drawn from the palettes the
 * chrome already uses: Tokyo Night for the dark theme and Tokyo Night Day for
 * the light theme, because the light chrome's primary `#7aa2f7` is only 2.3:1
 * on the light canvas and too weak for a 1px line.
 *
 * Every value is measured against the theme's canvas backdrop in
 * `overlay-theme.contrast.test.ts`: the clear colour for light and dark, and
 * for the colourful theme the stops of its canvas gradient from 32% down (the
 * band the model occupies). Lines and handles must clear 3:1 (WCAG 1.4.11);
 * ink used as label text must clear 4.5:1 (WCAG 1.4.3). Where a token cannot
 * reach 4.5:1 it is a graphics-only token and accent-coloured *text* is set as
 * ink on an accent-bordered label instead.
 */

import type { ThemeMode } from '@/store/slices/uiSlice';

/** The tokens, named as the CSS custom properties and Tailwind utilities spell them. */
export const OVERLAY_TOKENS = [
  'overlay-accent',
  'overlay-accent-soft',
  'overlay-ink',
  'overlay-ink-muted',
  'overlay-halo',
  'axis-x',
  'axis-y',
  'axis-z',
  'status-danger',
  'status-warn',
  'status-ok',
  'status-info',
  'clash-a',
  'clash-b',
  'clash-overlap',
  'paper',
  'paper-ink',
] as const;

export type OverlayToken = (typeof OVERLAY_TOKENS)[number];

/** A CSS colour: `#rrggbb` or `#rrggbbaa`. Kept to hex so one parser serves CSS and the GPU. */
export type OverlayPalette = Readonly<Record<OverlayToken, string>>;

/**
 * Light: Tokyo Night Day on the `#f5f5f7` clear colour.
 * Accent 3.7:1 (lines), ink 14.3:1, ink-muted 4.8:1 (the palette's `#6172b0`
 * measured 4.25:1, so it is mixed 10% toward the ink to clear text).
 */
const LIGHT: OverlayPalette = {
  'overlay-accent': '#2e7de9',
  'overlay-accent-soft': '#2e7de929',
  'overlay-ink': '#1f2335',
  'overlay-ink-muted': '#5a6aa4',
  'overlay-halo': '#ffffff',
  'axis-x': '#f52a65',
  'axis-y': '#587539',
  'axis-z': '#007197',
  'status-danger': '#f52a65',
  'status-warn': '#8c6c3e',
  'status-ok': '#587539',
  'status-info': '#007197',
  'clash-a': '#8c6c3e',
  'clash-b': '#007197',
  'clash-overlap': '#f52a65',
  paper: '#ffffff',
  'paper-ink': '#1f2335',
};

/**
 * Dark: Tokyo Night on the `#1a1b26` clear colour.
 * Accent 6.8:1, ink 10.6:1, ink-muted 5.2:1 (the palette's `#737aa2` measured
 * 4.1:1; `#828bb8` is the chrome's own accessible muted foreground).
 */
const DARK: OverlayPalette = {
  'overlay-accent': '#7aa2f7',
  'overlay-accent-soft': '#7aa2f72e',
  'overlay-ink': '#c0caf5',
  'overlay-ink-muted': '#828bb8',
  'overlay-halo': '#1a1b26',
  'axis-x': '#f7768e',
  'axis-y': '#9ece6a',
  'axis-z': '#7dcfff',
  'status-danger': '#f7768e',
  'status-warn': '#e0af68',
  'status-ok': '#9ece6a',
  'status-info': '#7dcfff',
  'clash-a': '#e0af68',
  'clash-b': '#7dcfff',
  'clash-overlap': '#f7768e',
  paper: '#16161e',
  'paper-ink': '#c0caf5',
};

/**
 * Colourful: the canvas clears to transparent over {@link COLORFUL_CANVAS_GRADIENT},
 * a dusk gradient from slate blue to sand whose model band (32% down) sits at
 * relative luminance 0.37 to 0.77. No mid-lightness hue clears 3:1 across that
 * band, so this palette is the light palette pushed down to luminance ~0.07
 * per hue (each channel scaled until the 32% stop clears 3.4:1). The chrome's
 * purple is not used (charter decision 2): the accent keeps the app blue's hue
 * so the 3D vocabulary reads the same in every theme, deep enough to sit on
 * the gradient and vivid enough to separate from the near-black ink by chroma.
 */
const COLORFUL: OverlayPalette = {
  'overlay-accent': '#1e40af',
  'overlay-accent-soft': '#1e40af29',
  'overlay-ink': '#1a1b2e',
  'overlay-ink-muted': '#464b62',
  'overlay-halo': '#ffffff',
  'axis-x': '#93193d',
  'axis-y': '#3e5228',
  'axis-z': '#00516d',
  'status-danger': '#93193d',
  'status-warn': '#5c4729',
  'status-ok': '#3e5228',
  'status-info': '#00516d',
  'clash-a': '#5c4729',
  'clash-b': '#00516d',
  'clash-overlap': '#93193d',
  paper: '#ffffff',
  'paper-ink': '#1a1b2e',
};

export const OVERLAY_PALETTES: Readonly<Record<ThemeMode, OverlayPalette>> = {
  light: LIGHT,
  dark: DARK,
  colorful: COLORFUL,
};

/**
 * The colourful theme's canvas backdrop. The WebGPU clear colour is transparent
 * there and this CSS gradient on the `<canvas>` shows through; `Viewport.tsx`
 * paints it and the contrast test measures against it.
 */
export const COLORFUL_CANVAS_GRADIENT_STOPS: ReadonlyArray<readonly [color: string, offsetPercent: number]> = [
  ['#4a5a8a', 0],
  ['#6272a8', 10],
  ['#7e8dba', 20],
  ['#9aa3c8', 32],
  ['#b5b8d1', 44],
  ['#cdc3d4', 56],
  ['#dcccc8', 68],
  ['#e8d5be', 80],
  ['#f0ddb8', 92],
  ['#f5e2b6', 100],
];

export const COLORFUL_CANVAS_GRADIENT = `linear-gradient(180deg, ${COLORFUL_CANVAS_GRADIENT_STOPS
  .map(([color, offset]) => `${color} ${offset}%`)
  .join(', ')})`;

/** The custom property a token is published under on `<html>`, e.g. `--overlay-axis-x`. */
export function overlayCssVar(token: OverlayToken): `--${string}` {
  return token.startsWith('overlay-') ? `--${token}` : `--overlay-${token}`;
}

/**
 * A token as a CSS colour value, `var(--overlay-axis-x)`, for the places a
 * Tailwind utility cannot reach: an SVG presentation attribute or inline style
 * whose colour is picked at runtime. Prefer the utility (`stroke-axis-x`)
 * wherever the class is static.
 */
export function overlayColor(token: OverlayToken): string {
  return `var(${overlayCssVar(token)})`;
}

/**
 * The one X/Y/Z triad (#5490), as CSS colours keyed by IFC axis. Every
 * axis-coded mark (the axis helper, the move and placement gizmos, the
 * measure tool's shift-drag constraint axes) reads its colour here, so they
 * cannot drift apart again. IFC is Z-up and the renderer frame is Y-up:
 * renderer +Y is IFC Z and renderer -Z is IFC Y.
 */
export const IFC_AXIS_COLORS: Readonly<Record<'x' | 'y' | 'z', string>> = {
  x: overlayColor('axis-x'),
  y: overlayColor('axis-y'),
  z: overlayColor('axis-z'),
};

/** `[r, g, b, a]` in 0..1. */
export type Rgba = readonly [number, number, number, number];

const HEX_RE = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;

/**
 * Parse a token value into sRGB-encoded `[r, g, b, a]` in 0..1: the convention
 * of the renderer's clear colour and `Renderer.setOverlayTheme`'s `overlayLine`,
 * `sectionPlane`, `clashA`, `clashB` and `clashOverlap` fields, which write their
 * values to the swap chain unchanged (see `rendererOverlayTheme` in
 * `overlay-theme-renderer.ts`, and `OverlayTheme` in `@ifc-lite/renderer`).
 */
export function tokenToRgba(value: string): Rgba {
  const m = HEX_RE.exec(value);
  if (!m) throw new Error(`overlay token must be #rrggbb or #rrggbbaa, got ${JSON.stringify(value)}`);
  const rgb = m[1];
  const r = parseInt(rgb.slice(0, 2), 16) / 255;
  const g = parseInt(rgb.slice(2, 4), 16) / 255;
  const b = parseInt(rgb.slice(4, 6), 16) / 255;
  const a = m[2] === undefined ? 1 : parseInt(m[2], 16) / 255;
  return [r, g, b, a];
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * Parse a token value into linear-light `[r, g, b, a]`: the convention of the
 * lit mesh pipeline (`main.wgsl.ts`), which gamma-encodes on output, so a
 * selection tint fed sRGB values there would wash out.
 */
export function tokenToLinearRgba(value: string): Rgba {
  const [r, g, b, a] = tokenToRgba(value);
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), a];
}
