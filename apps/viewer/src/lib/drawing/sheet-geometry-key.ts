/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DrawingSheet } from '@ifc-lite/drawing-2d';
import type { SectionAxis } from '@/hooks/pdfSectionLayout';

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
 * Used by `useViewControls` (which clears the cache when this key changes)
 * and, via {@link sheetTransformCacheKeyOf}, by the READ site in
 * `resolveSheetTransform`, which validates the cached entry rather than
 * trusting the write-site clear — see the module doc on
 * `cachedSheetTransformRef` in Drawing2DCanvas.tsx for why that clear alone
 * is not enough to prevent a stale draw.
 */
export function sheetGeometryKeyOf(sheet: DrawingSheet | null | undefined): string | null {
  if (!sheet) return null;
  return `${sheet.id}|${sheet.paper.widthMm}x${sheet.paper.heightMm}|${sheet.viewportBounds.x},${sheet.viewportBounds.y},${sheet.viewportBounds.width},${sheet.viewportBounds.height}|${sheet.scale.factor}`;
}

/**
 * The key a CACHED TRANSFORM is tagged with: the sheet geometry key plus the
 * section axis the transform was computed under.
 *
 * The axis belongs here even though it is not part of the sheet, because the
 * cached transform carries the axis's flips: `calculateDrawingTransformForAxis`
 * folds `flipX`/`flipY` into `translateX`/`translateY`. Keyed on geometry
 * alone, an entry written under one axis is served to a resolve on another —
 * a transform corrected for one set of flips, applied with a different set,
 * which on a 1:100 A3 sheet puts the drawing off the paper entirely.
 *
 * `sheetGeometryKeyOf` stays axis-free: `useViewControls` uses it to decide
 * when the SHEET changed, and clears the cache on an axis change separately.
 */
export function sheetTransformCacheKeyOf(
  sheet: DrawingSheet | null | undefined,
  axis: SectionAxis,
): string | null {
  const geometry = sheetGeometryKeyOf(sheet);
  return geometry === null ? null : `${geometry}|${axis}`;
}

/**
 * The pinned-sheet transform cache entry, self-describing: `key` is the
 * `sheetTransformCacheKeyOf()` of the sheet AND axis it was computed FOR, so
 * a reader can reject it on a mismatch instead of trusting that some other
 * effect already cleared it. See {@link sheetTransformCacheKeyOf}.
 */
export interface CachedSheetTransform {
  key: string | null;
  translateX: number;
  translateY: number;
  scaleFactor: number;
}
