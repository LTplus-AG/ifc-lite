/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Writing the scale bar and the "1:N" text onto the page (#2042).
 *
 * The layout is decided in `@ifc-lite/drawing-2d` (`addScaleStamp`), which
 * knows the scale and nothing about PDFs; this file knows jsPDF and nothing
 * about scale. That split is the point: the sibling renderers in the package's
 * `sheet/` folder emit SVG strings, which a PDF writer cannot use, and every
 * millimetre here comes from the stamp rather than from a second computation
 * that could disagree with the drawing it sits under.
 *
 * The one number this file does compute is the font size, because points are a
 * PDF unit: jsPDF measures text in points whatever the document unit is, so a
 * height authored in millimetres has to be converted at exactly 72 pt to the
 * inch. Getting that wrong makes the label the wrong size, which is ugly and
 * harmless — no measurement on the sheet depends on it, the bar does.
 */

import type { ScaleStamp } from '@ifc-lite/drawing-2d';

/** The slice of jsPDF the stamp writer uses, so a test can stand in for it. */
export interface ViewPdfStampTarget {
  setDrawColor(r: number, g: number, b: number): void;
  setFillColor(r: number, g: number, b: number): void;
  setTextColor(r: number, g: number, b: number): void;
  setLineWidth(width: number): void;
  setLineDashPattern(pattern: number[], phase: number): void;
  setFontSize(sizePt: number): void;
  /** `'FD'` fills and strokes, `'S'` strokes only. */
  rect(xMm: number, yMm: number, widthMm: number, heightMm: number, style: 'S' | 'FD'): void;
  text(text: string, xMm: number, yMm: number, options: { align: 'left' | 'center' }): void;
}

/** Millimetres in one PostScript point. */
const MM_PER_POINT = 25.4 / 72;

/** Stroke weight of the bar outline, mm. Thin enough not to eat a division. */
const STAMP_LINE_WIDTH_MM = 0.18;

/**
 * Draw `stamp` at the absolute page millimetres it was laid out at.
 *
 * Call it LAST. A PDF paints in call order, and the band sits outside the
 * drawing area anyway, so nothing can cover it — but the drawing state
 * (colour, dash pattern, line width) is left where this function set it, so
 * anything written afterwards would inherit it.
 */
export function drawScaleStamp(doc: ViewPdfStampTarget, stamp: ScaleStamp): void {
  doc.setDrawColor(0, 0, 0);
  doc.setFillColor(0, 0, 0);
  doc.setTextColor(0, 0, 0);
  // Explicit, not inherited: the line-work writer's last stroke may have been
  // a dashed hidden edge, and a dashed scale bar reads as a damaged one.
  doc.setLineDashPattern([], 0);
  doc.setLineWidth(STAMP_LINE_WIDTH_MM);

  for (const rect of stamp.rects) {
    doc.rect(rect.xMm, rect.yMm, rect.widthMm, rect.heightMm, rect.filled ? 'FD' : 'S');
  }
  for (const text of stamp.texts) {
    doc.setFontSize(text.heightMm / MM_PER_POINT);
    doc.text(text.text, text.xMm, text.yMm, { align: text.align });
  }
}
