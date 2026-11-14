/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DxfUnderlayText } from './types.js';

/** AutoCAD MTEXT line pitch at spacing factor 1, in text heights (5/3). */
export const DXF_TEXT_LINE_HEIGHT_FACTOR = 5 / 3;

/** Average glyph advance in ems; renderers cannot measure exact font widths here. */
export const DXF_TEXT_GLYPH_WIDTH_EM = 0.6;

/** Estimated width of a single text line at `height`, for aligned/fit stretching. */
export function dxfEstimatedTextWidth(text: string, height: number): number {
  return text.length * height * DXF_TEXT_GLYPH_WIDTH_EM;
}

/** A group-41 width factor worth writing: finite, positive and not 1. */
export function dxfWidthFactor(scale: number | undefined): number | undefined {
  return scale !== undefined && Number.isFinite(scale) && scale > 0 && scale !== 1 ? scale : undefined;
}

/**
 * Offset of line `index` of a `lineCount`-line DXF text block from its
 * insertion point, measured across the baseline towards the glyph feet, in
 * the units of `height`. Every renderer stacks lines along this offset and
 * keeps each line's own `valign`, so the whole block sits where DXF puts it:
 * top (and baseline) attachment grows down from the point, middle attachment
 * is centred on it, and bottom attachment grows up from it, with the last
 * line on the point. Single-line text is never offset.
 */
export function dxfTextLineOffset(index: number, lineCount: number,
  valign: DxfUnderlayText['valign'], height: number, lineSpacingFactor: number | undefined = 1): number {
  const first = valign === 'bottom' ? 1 - lineCount : valign === 'middle' ? (1 - lineCount) / 2 : 0;
  return (first + index) * height * DXF_TEXT_LINE_HEIGHT_FACTOR * (lineSpacingFactor ?? 1);
}
