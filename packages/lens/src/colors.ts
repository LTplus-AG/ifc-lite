/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RGBAColor } from './types.js';

/** Ghost color for unmatched entities: faint gray at low opacity */
export const GHOST_COLOR: RGBAColor = [0.6, 0.6, 0.6, 0.15];

const HEX3 = /^[0-9a-f]{3}$/i;
const HEX6 = /^[0-9a-f]{6}$/i;

/**
 * Parse hex color string to RGBA tuple (0–1 range).
 *
 * `hex` is not always a native `<input type="color">` value: it also arrives
 * from imported lens JSON (no schema validation) and from the SDK's
 * `bim.viewer.colorize()`, a published entry point any external caller can
 * pass an arbitrary string to. Both accept the 3-digit CSS shorthand and
 * neither is guaranteed well-formed. Rather than let `parseInt` salvage
 * whatever hex-looking prefix it can find in a malformed string — which
 * turns a typo like `'red'` into a plausible-but-wrong color instead of
 * flagging it — the whole (post-shorthand-expansion) string is validated as
 * exactly six hex digits before parsing, and any input that fails that
 * check, including the wrong length, falls back to `[0, 0, 0, alpha]`. It
 * does not throw: this is a published SDK entry point and an unvalidated
 * JSON import path, and a throw here would crash the caller for one bad
 * value instead of degrading a single color.
 *
 * @param hex - Hex color (e.g. "#E53935", "E53935", or the 3-digit "#E33")
 * @param alpha - Alpha value in 0–1 range
 */
export function hexToRgba(hex: string, alpha: number): RGBAColor {
  let h = hex.replace('#', '');
  if (HEX3.test(h)) {
    h = h.split('').map((c) => c + c).join('');
  }
  // `parseInt` salvages whatever hex prefix it can find in a substring, so a
  // naive `parseInt(h.substring(0, 2), 16)` turns garbage like 'red' (which
  // is not a color at all) into a plausible-looking non-zero channel, and a
  // too-long string like '#1234567' silently loses its last digit instead of
  // being rejected. Validating the whole (post-shorthand-expansion) string as
  // exactly six hex digits before parsing closes both holes in one guard.
  if (!HEX6.test(h)) {
    return [0, 0, 0, alpha];
  }
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return [r / 255, g / 255, b / 255, alpha];
}

/**
 * Convert RGBA tuple to hex color string (ignores alpha).
 *
 * @param rgba - RGBA tuple with values in 0–1 range
 * @returns Hex string like "#e53935"
 */
export function rgbaToHex(rgba: RGBAColor): string {
  const r = Math.round(rgba[0] * 255).toString(16).padStart(2, '0');
  const g = Math.round(rgba[1] * 255).toString(16).padStart(2, '0');
  const b = Math.round(rgba[2] * 255).toString(16).padStart(2, '0');
  return `#${r}${g}${b}`;
}

/**
 * Check if a color is a ghost color (alpha < 0.2).
 * Used to exclude ghost entries from UI legends.
 */
export function isGhostColor(rgba: RGBAColor): boolean {
  return rgba[3] < 0.2;
}

/**
 * Golden angle in degrees (~137.508°).
 * Successive multiples of this produce maximally distributed hues
 * on the color wheel — guarantees every new color is as far as
 * possible from all previously generated colors, for any N.
 */
const GOLDEN_ANGLE = 137.508;

/**
 * Convert HSL to hex string.
 * h in [0, 360), s and l in [0, 1].
 */
function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;

  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }

  const ri = Math.round((r + m) * 255);
  const gi = Math.round((g + m) * 255);
  const bi = Math.round((b + m) * 255);
  return `#${ri.toString(16).padStart(2, '0')}${gi.toString(16).padStart(2, '0')}${bi.toString(16).padStart(2, '0')}`;
}

/**
 * Generate a unique color for index `i` using golden-angle hue distribution.
 *
 * Produces unlimited perceptually distinct colors:
 * - Hue: golden angle spacing (maximally distributed for any N)
 * - Saturation: alternates between 65% and 80% to add variety
 * - Lightness: cycles through 3 levels (45%, 55%, 35%) for depth
 *
 * Colors are visually distinct for typical N. The hue uses golden-angle
 * spacing to stay maximally separated, but exact-hex collisions are
 * possible beyond ~1.8k distinct values (the first occurs at i=1842,
 * which matches i=12) because the output is quantized to 6-digit hex.
 */
export function uniqueColor(i: number): string {
  const hue = (i * GOLDEN_ANGLE) % 360;
  const saturation = i % 2 === 0 ? 0.65 : 0.80;
  const lightnessLevels = [0.45, 0.55, 0.35];
  const lightness = lightnessLevels[i % 3];
  return hslToHex(hue, saturation, lightness);
}
