/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Deterministic per-zone colour so a zone set with no explicit `Zone.color`
 * still renders each box in a distinct, stable hue (stable across reloads
 * because it's derived from the zone's index, not `Math.random()`).
 */

/** 8-colour palette, evenly spaced hues at fixed saturation/lightness so
 *  every colour reads clearly against both light and dark scenes. */
const PALETTE_HUES = [210, 25, 140, 280, 50, 190, 320, 90] as const;

function hslToRgb01(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let [r, g, b] = [0, 0, 0];
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

/** Deterministic display colour for the zone at `index` within its set. */
export function zoneColorForIndex(index: number): [number, number, number] {
  const hue = PALETTE_HUES[index % PALETTE_HUES.length];
  return hslToRgb01(hue, 0.65, 0.55);
}
