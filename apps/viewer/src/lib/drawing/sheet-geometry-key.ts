/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DrawingSheet } from '@ifc-lite/drawing-2d';

/**
 * Everything `Drawing2DCanvas`'s pinned-transform cache is actually derived
 * FROM (`calculateDrawingTransform(drawingBounds, viewport, activeSheet.scale)`),
 * folded into one comparable string — id, paper size, viewport bounds and
 * scale factor. `setPaperSize`, `setFrameStyle`/`updateFrameMargins` (both
 * recompute `viewportBounds`) and `setDrawingScale` all mutate the SAME
 * `activeSheet.id` in place (sheetSlice.ts), while `loadTemplate` swaps in a
 * different id entirely — any of these must be visible here even though the
 * sheet's `id` alone would not change for the first three (PR #2853 review).
 *
 * Shared between `useViewControls` (which clears the cache when this key
 * changes) and `Drawing2DCanvas` (which validates the cache against this key
 * at the READ site, not just the write site — see the module doc on
 * `cachedSheetTransformRef` in Drawing2DCanvas.tsx for why the write-site
 * clear alone is not enough to prevent a stale draw).
 */
export function sheetGeometryKeyOf(sheet: DrawingSheet | null | undefined): string | null {
  if (!sheet) return null;
  return `${sheet.id}|${sheet.paper.widthMm}x${sheet.paper.heightMm}|${sheet.viewportBounds.x},${sheet.viewportBounds.y},${sheet.viewportBounds.width},${sheet.viewportBounds.height}|${sheet.scale.factor}`;
}

/**
 * The pinned-sheet transform cache entry, self-describing: `key` is the
 * `sheetGeometryKeyOf()` of the sheet it was computed FOR, so a reader can
 * reject it on a mismatch instead of trusting that some other effect already
 * cleared it. See {@link sheetGeometryKeyOf}.
 */
export interface CachedSheetTransform {
  key: string | null;
  translateX: number;
  translateY: number;
  scaleFactor: number;
}
