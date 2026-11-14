/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DxfUnderlayText } from './types.js';

/** Multiline DXF text line spacing, in text heights. */
export const DXF_TEXT_LINE_HEIGHT_FACTOR = 1.3;

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
  valign: DxfUnderlayText['valign'], height: number): number {
  const first = valign === 'bottom' ? 1 - lineCount : valign === 'middle' ? (1 - lineCount) / 2 : 0;
  return (first + index) * height * DXF_TEXT_LINE_HEIGHT_FACTOR;
}
