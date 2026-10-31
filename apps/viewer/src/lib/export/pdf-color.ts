/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export type PdfColor = { color: string; alpha: number };

/** Hex and comma `rgb()`/`rgba()`, the forms a browser canvas also emits. */
function parseHexOrRgb(css: string): PdfColor | null {
  const short = /^#([0-9a-f]{3,4})$/.exec(css);
  const hex = short ? `#${[...short[1]].map((c) => c + c).join('')}` : css;
  const long = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(hex);
  if (long) return { color: `#${long[1]}`, alpha: long[2] ? parseInt(long[2], 16) / 255 : 1 };
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/.exec(css);
  if (!rgb || [rgb[1], rgb[2], rgb[3]].some((c) => +c > 255)) return null;
  const byte = (c: string) => (+c).toString(16).padStart(2, '0');
  return { color: `#${byte(rgb[1])}${byte(rgb[2])}${byte(rgb[3])}`, alpha: rgb[4] === undefined ? 1 : Math.min(1, +rgb[4]) };
}

/**
 * Let the browser resolve other CSS colours (names, hsl(), space syntax,
 * percentages) as the canvas and SVG do: a 2D context normalises a valid
 * sRGB `fillStyle` to `#rrggbb` or `rgba(...)` and ignores an invalid one,
 * which two different sentinels detect. Null where no canvas exists, and for
 * wide-gamut colours the browser serialises in their own space (oklch()).
 */
function resolveWithCanvas(css: string): PdfColor | null {
  const ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  const tryWith = (sentinel: string) => {
    ctx.fillStyle = sentinel;
    ctx.fillStyle = css;
    return String(ctx.fillStyle);
  };
  const first = tryWith('#010203');
  if (first === '#010203' && tryWith('#040506') === '#040506') return null;
  return parseHexOrRgb(first);
}

/**
 * Split a CSS colour into what jsPDF accepts (`#RRGGBB`) and an alpha factor.
 * jsPDF rejects alpha hex (`#RGBA`, `#RRGGBBAA`) and `rgba()`, which
 * overrides may carry, and it reads any unknown 3- or 6-letter word as hex
 * (`bad` becomes #bbaadd), so other forms are resolved by the browser first.
 * `transparent` and `none` are fully transparent. Returns null for anything
 * invalid (an unfinished `#12` typed into the override panel) and the caller
 * substitutes a fallback.
 */
export function pdfColor(input: string): PdfColor | null {
  const css = input.trim().toLowerCase();
  if (css === 'transparent' || css === 'none') return { color: '#000000', alpha: 0 };
  return parseHexOrRgb(css) ?? resolveWithCanvas(css);
}
