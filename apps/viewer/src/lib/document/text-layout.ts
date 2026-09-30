/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** A single line, ellipsis-truncated to fit `width` by the same measure `wrapText` uses (#4940 review: a half-width chart's title/subtitle must not run into the next column). */
export function truncateToWidth(text: string, width: number, size: number, bold: boolean, measure: (text: string, size: number, bold: boolean) => number): string {
  if (width <= 0 || measure(text, size, bold) <= width) return text;
  // Binary, not linear: a linear cut-by-one scan remeasures a near-full string once per code
  // unit, quadratic in an imported title's length (review finding). `measure` grows monotonically
  // with the prefix length for both measures this module is called with (jsPDF's textWidth, the
  // character-count estimate), so the longest prefix that still fits is found by bisection.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const cut = Math.ceil((low + high) / 2);
    if (measure(`${text.slice(0, cut)}…`, size, bold) <= width) low = cut;
    else high = cut - 1;
  }
  return low > 0 ? `${text.slice(0, low)}…` : '…';
}

