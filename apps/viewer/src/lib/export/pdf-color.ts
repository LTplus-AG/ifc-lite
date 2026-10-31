/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Split a CSS colour into what jsPDF accepts (`#RRGGBB`) and an alpha factor.
 * jsPDF rejects alpha hex (`#RGBA`, `#RRGGBBAA`) and `rgba()`, which
 * overrides may carry. `transparent` and `none` are fully transparent.
 * Returns null for anything else, and the caller substitutes a fallback:
 * jsPDF writes an unfinished `#12` as a broken operator and throws on
 * unknown names. Named colours and other CSS forms are not mapped.
 */
export function pdfColor(input: string): { hex: string; alpha: number } | null {
  const color = input.trim().toLowerCase();
  if (color === 'transparent' || color === 'none') return { hex: '#000000', alpha: 0 };
  const short = /^#([0-9a-f]{3,4})$/.exec(color);
  const hex = short ? `#${[...short[1]].map((c) => c + c).join('')}` : color;
  const long = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(hex);
  if (long) return { hex: `#${long[1]}`, alpha: long[2] ? parseInt(long[2], 16) / 255 : 1 };
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/.exec(color);
  if (!rgb || [rgb[1], rgb[2], rgb[3]].some((c) => +c > 255)) return null;
  const byte = (c: string) => (+c).toString(16).padStart(2, '0');
  return { hex: `#${byte(rgb[1])}${byte(rgb[2])}${byte(rgb[3])}`, alpha: rgb[4] === undefined ? 1 : Math.min(1, +rgb[4]) };
}
