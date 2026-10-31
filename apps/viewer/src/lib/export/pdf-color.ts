/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Split a CSS hex colour into what jsPDF accepts (`#RRGGBB`) and an alpha
 * factor. Overrides allow `#RRGGBBAA`, which jsPDF's colour parser rejects.
 * Returns null for anything else (an unfinished `#12` typed into the
 * override panel, `none`, `transparent`): jsPDF writes those as broken
 * operators or throws, so the caller substitutes a fallback.
 */
export function pdfColor(color: string): { hex: string; alpha: number } | null {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
  if (short) return { hex: `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`, alpha: 1 };
  const long = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (long) return { hex: `#${long[1]}`, alpha: long[2] ? parseInt(long[2], 16) / 255 : 1 };
  return null;
}
