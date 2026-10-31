/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const hex2 = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');

/**
 * Split a CSS colour into what jsPDF accepts (`#RRGGBB`) and an alpha factor.
 * jsPDF rejects alpha hex (`#RGBA`, `#RRGGBBAA`) and `rgb()`/`rgba()`, which
 * overrides may carry. `transparent` and `none` are fully transparent.
 * Returns null for anything else (an unfinished `#12` typed into the
 * override panel): jsPDF writes those as broken operators or throws, so the
 * caller substitutes a fallback.
 */
export function pdfColor(input: string): { hex: string; alpha: number } | null {
  const color = input.trim().toLowerCase();
  if (color === 'transparent' || color === 'none') return { hex: '#000000', alpha: 0 };
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/.exec(color);
  if (short) {
    return {
      hex: `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`,
      alpha: short[4] ? parseInt(short[4] + short[4], 16) / 255 : 1,
    };
  }
  const long = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(color);
  if (long) return { hex: `#${long[1]}`, alpha: long[2] ? parseInt(long[2], 16) / 255 : 1 };
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color);
  if (rgb) {
    return {
      hex: `#${hex2(+rgb[1])}${hex2(+rgb[2])}${hex2(+rgb[3])}`,
      alpha: rgb[4] === undefined ? 1 : Math.min(1, Math.max(0, +rgb[4])),
    };
  }
  return null;
}
