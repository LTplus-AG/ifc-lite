/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { calculateDrawingTransformForAxis, type DrawingSheet } from '@ifc-lite/drawing-2d';
import { axisFlipForSection, type SectionAxis } from '@/hooks/pdfSectionLayout';
import { sheetTransformCacheKeyOf, type CachedSheetTransform } from './sheet-geometry-key';

/** Drawing bounds in the flat `minX/minY/maxX/maxY` shape
 *  `calculateDrawingTransformForAxis` takes (model units, metres). */
export interface DrawingBoundsRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ResolveSheetTransformArgs {
  /** The sheet the drawing is being placed on. Supplies the viewport and the
   *  paper scale, and (with `axis`, via {@link sheetTransformCacheKeyOf}) the
   *  key the cached entry is validated against. */
  sheet: DrawingSheet;
  /** Bounds of the drawing being placed. */
  drawingBounds: DrawingBoundsRect;
  /** Section axis. The ONLY input the flips are derived from — see
   *  {@link axisFlipForSection}. */
  axis: SectionAxis;
  /** Whether Pin View is on. Only a pinned resolve may read the cache. */
  isPinned: boolean;
  /** The pinned-transform cache entry, or null/undefined when there is none. */
  cached: CachedSheetTransform | null | undefined;
}

export interface ResolvedSheetTransform {
  /** Drawing (metres) -> paper (mm) placement. */
  transform: { translateX: number; translateY: number; scaleFactor: number };
  /** The per-axis flips the CALLER must apply to each point before applying
   *  `transform` — returned rather than re-derived so a consumer physically
   *  cannot pair one axis's transform with another axis's flips. */
  flipX: boolean;
  flipY: boolean;
  /** `sheetTransformCacheKeyOf(sheet, axis)` — what a caller that owns the
   *  cache must tag a freshly computed entry with. It covers the axis as well
   *  as the sheet geometry, so an entry can never be served to a resolve on a
   *  different axis; see {@link sheetTransformCacheKeyOf}. */
  key: string | null;
  /** True when `transform` came from `cached` rather than being recomputed.
   *  A caller that owns the cache writes only when this is false; a caller
   *  that does not own it (the export path) never writes at all. */
  fromCache: boolean;
}

/**
 * The single place the sheet PREVIEW (`Drawing2DCanvas`) and the sheet
 * PRINT/EXPORT path (`useDrawingExport`'s `generateSheetSVG`) decide where
 * the drawing lands on paper.
 *
 * Two independent ways those two paths had drifted, both fixed by going
 * through here:
 *
 *  1. The per-axis flips (`flipX`/`flipY`) and the transform corrected for
 *     them were derived separately at each call site. They now come out of
 *     one call, from one input (`axis`), via the same `axisFlipForSection`
 *     the PDF section exporter already used.
 *  2. The cache read. `Drawing2DCanvas` reuses a cached transform while Pin
 *     View is on — that is what pinning IS: the placement is held while the
 *     drawing's bounds change underneath it. `generateSheetSVG` never saw
 *     `isPinned` at all, so it recomputed from the CURRENT bounds. Since
 *     `sheetGeometryKeyOf` deliberately does not cover the drawing bounds
 *     (bounds are exactly what pinning holds constant), the cache stays
 *     valid across a regenerate at a new elevation: the preview kept the
 *     held placement and the print computed a different one. Pin View
 *     defaults ON (`Section2DPanel.tsx`), so this was the default path.
 *
 * Ownership of the cache stays with the preview: this function only READS
 * it. Printing must never perturb what is on screen, so the export path
 * passes the ref's current value and writes nothing back; the preview writes
 * the entry itself when `fromCache` is false. See `useViewControls.ts`'s
 * `cachedSheetTransformRef` docs for the invalidation rules.
 *
 * The cached entry is validated against the CURRENT sheet's geometry key AND
 * the current axis before reuse, rather than trusted because it is present —
 * see {@link sheetTransformCacheKeyOf} for why the axis has to be in that key
 * and why the write-site clear alone is not enough.
 */
export function resolveSheetTransform({
  sheet,
  drawingBounds,
  axis,
  isPinned,
  cached,
}: ResolveSheetTransformArgs): ResolvedSheetTransform {
  const { flipX, flipY } = axisFlipForSection(axis);
  const key = sheetTransformCacheKeyOf(sheet, axis);

  if (isPinned && cached && cached.key === key) {
    return {
      transform: {
        translateX: cached.translateX,
        translateY: cached.translateY,
        scaleFactor: cached.scaleFactor,
      },
      flipX,
      flipY,
      key,
      fromCache: true,
    };
  }

  return {
    transform: calculateDrawingTransformForAxis(
      drawingBounds,
      sheet.viewportBounds,
      sheet.scale,
      flipY,
      flipX,
    ),
    flipX,
    flipY,
    key,
    fromCache: false,
  };
}
