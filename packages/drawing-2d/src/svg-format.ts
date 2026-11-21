/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one place a number becomes SVG text. `NaN`/`Infinity` stringify
 * verbatim through `toFixed`, which a conforming renderer must reject, so
 * every coordinate/size/rotation routes through here (mirrors the DXF
 * writer's single `fmt()`). Non-finite becomes `0`: the document stays
 * parseable and the degenerate geometry collapses at the visible origin.
 */
export function svgNum(n: number, digits = 3): string {
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(digits);
}

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
