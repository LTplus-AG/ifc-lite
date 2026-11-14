/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Cap height of the standard PDF Helvetica, in ems. */
export const PDF_HELVETICA_CAP_HEIGHT_EM = 0.718;
/** Descender depth of the standard PDF Helvetica, in ems. */
export const PDF_HELVETICA_DESCENT_EM = 0.207;

export type PdfTextAlign = 'left' | 'center' | 'right';
export type PdfTextValign = 'baseline' | 'bottom' | 'middle' | 'top';

/**
 * Start of a line's alphabetic baseline on a y-down page, so that the
 * justification holds along a rotated baseline. jsPDF applies its own
 * `align`/`baseline` options along the page axes, not along the rotated
 * text, so callers place the start here and pass only `angle`.
 *
 * `angleRad` is the baseline direction measured on the page (y down), i.e.
 * `atan2(tip.y - anchor.y, tip.x - anchor.x)`; jsPDF's `angle` is its
 * negation in degrees. `lineOffset` stacks further lines across the
 * baseline, towards the glyph feet, in the same units as `widthMm`.
 */
export function pdfRotatedTextStart(anchor: { x: number; y: number }, angleRad: number, widthMm: number,
  sizeMm: number, align: PdfTextAlign, valign: PdfTextValign, lineOffset = 0): { x: number; y: number } {
  const along = { x: Math.cos(angleRad), y: Math.sin(angleRad) };
  const down = { x: -along.y, y: along.x };
  const back = align === 'center' ? widthMm / 2 : align === 'right' ? widthMm : 0;
  const drop = lineOffset + sizeMm * (valign === 'top' ? PDF_HELVETICA_CAP_HEIGHT_EM
    : valign === 'middle' ? PDF_HELVETICA_CAP_HEIGHT_EM / 2
      : valign === 'bottom' ? -PDF_HELVETICA_DESCENT_EM : 0);
  return { x: anchor.x - along.x * back + down.x * drop, y: anchor.y - along.y * back + down.y * drop };
}
