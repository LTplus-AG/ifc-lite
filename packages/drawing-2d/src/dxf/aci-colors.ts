/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AutoCAD Color Index (ACI) → CSS colour.
 *
 * Indices 1-9 and 250-255 use the exact classic values. The 240 chromatic
 * entries (10-249) are generated from the ACI band structure — 24 hue bands
 * of 10 entries, alternating full/washed saturation over 5 brightness steps.
 * That reproduces the classic table closely (visually indistinguishable for
 * an underlay) without embedding 240 literals.
 *
 * ACI 7 is "white/black" (paper-dependent); the 2D canvas and SVG exports
 * draw on white, so it maps to black.
 */

function hsvToRgbInt(hueDeg: number, s: number, v: number): number {
  const c = v * s;
  const hp = (((hueDeg % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  const to255 = (f: number) => Math.round((f + m) * 255);
  return (to255(r) << 16) | (to255(g) << 8) | to255(b);
}

function buildAciTable(): number[] {
  const t = new Array<number>(256).fill(0x000000);
  t[1] = 0xff0000; // red
  t[2] = 0xffff00; // yellow
  t[3] = 0x00ff00; // green
  t[4] = 0x00ffff; // cyan
  t[5] = 0x0000ff; // blue
  t[6] = 0xff00ff; // magenta
  t[7] = 0x000000; // white/black → black on a white canvas
  t[8] = 0x414141;
  t[9] = 0x808080;

  const brightness = [1.0, 0.8, 0.6, 0.5, 0.35];
  for (let i = 10; i <= 249; i++) {
    const c = i - 10;
    const hue = Math.floor(c / 10) * 15;
    const v = brightness[Math.floor((c % 10) / 2)];
    const s = c % 2 === 1 ? 0.45 : 1.0;
    t[i] = hsvToRgbInt(hue, s, v);
  }

  const grays = [0x333333, 0x505050, 0x696969, 0x828282, 0xbebebe, 0xffffff];
  for (let i = 0; i < grays.length; i++) t[250 + i] = grays[i];
  return t;
}

const ACI_TABLE = buildAciTable();

export function rgbIntToCss(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
}

/** Resolve an ACI colour number (1-255) to a CSS hex colour. */
export function aciToCss(index: number): string {
  const i = Math.trunc(index);
  if (i < 1 || i > 255 || !Number.isFinite(i)) return '#000000';
  return rgbIntToCss(ACI_TABLE[i]);
}
