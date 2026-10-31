/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Split a CSS colour into what jsPDF accepts (`#RRGGBB`) and an alpha factor.
 * jsPDF rejects alpha hex (`#RGBA`, `#RRGGBBAA`) and `rgba()`, which
 * overrides may carry. `transparent` and `none` are fully transparent.
 * Returns null for anything else and the caller substitutes a fallback: an
 * unfinished `#12` typed into the override panel would be written as a broken
 * operator, and colour names are not passed on because jsPDF reads any
 * unknown 3- or 6-letter word as hex (`bad` becomes #bbaadd).
 */
export function pdfColor(input: string): { color: string; alpha: number } | null {
  const css = input.trim().toLowerCase();
  if (css === 'transparent' || css === 'none') return { color: '#000000', alpha: 0 };
  const short = /^#([0-9a-f]{3,4})$/.exec(css);
  const hex = short ? `#${[...short[1]].map((c) => c + c).join('')}` : css;
  const long = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(hex);
  if (long) return { color: `#${long[1]}`, alpha: long[2] ? parseInt(long[2], 16) / 255 : 1 };
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/.exec(css);
  if (!rgb || [rgb[1], rgb[2], rgb[3]].some((c) => +c > 255)) return null;
  const byte = (c: string) => (+c).toString(16).padStart(2, '0');
  return { color: `#${byte(rgb[1])}${byte(rgb[2])}${byte(rgb[3])}`, alpha: rgb[4] === undefined ? 1 : Math.min(1, +rgb[4]) };
}
