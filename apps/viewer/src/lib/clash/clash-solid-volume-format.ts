/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Status-line formatting for the on-demand intersection solid's volume
 * (#2574 CodeRabbit review). `ClashPanel` used a bare `toFixed(3)`, which
 * rounds every solid smaller than 0.5 litres (a small bolt/plate overlap, say)
 * down to the string "0.000 m³" — reading as "no volume" even though the
 * kernel resolved a genuine `isSolid: true` result with a real mesh on
 * screen. Fall back to scientific notation for exactly that band so a
 * nonzero solid never prints as zero.
 */

/** Render a clash-solid volume (m³) for the panel's status line, never as "0.000" for a nonzero value. */
export function formatClashSolidVolumeM3(volumeM3: number): string {
  if (!(volumeM3 > 0)) return '0.000 m³';
  const fixed = volumeM3.toFixed(3);
  // toFixed(3) rounds any nonzero volume under 0.0005 m³ to "0.000" — the
  // exact case this exists to catch.
  if (Number(fixed) === 0) return `${volumeM3.toExponential(2)} m³`;
  return `${fixed} m³`;
}
