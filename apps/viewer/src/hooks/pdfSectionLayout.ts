/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PDF section export layout (issue #2042 / showstopper found on PR #2119):
 * the axis-flip and page-layout arithmetic `useDrawingExport.ts`'s
 * `handleExportPDF` needs, extracted so it can be unit tested without a
 * `useViewerStore` / React / jsPDF dependency.
 *
 * The bug this exists to prevent: `computePdfScaleLayout`'s page offsets
 * are derived from `bounds.min`/`bounds.max` in their ORIGINAL (un-negated)
 * frame. `front`/`side` section exports negate X and/or Y per point when
 * mapping into paper space (matching the "as displayed" SVG export), so if
 * the layout is derived from the un-flipped bounds while points are drawn
 * flipped, the offsets are correct only when `bounds` happens to be
 * symmetric about zero — for any model at ordinary (positive) world
 * coordinates, the entire drawing lands off the page. The fix is to derive
 * the layout from the bounds AS THEY WILL BE DRAWN: flip first, then
 * compute the page/offsets from the flipped bounds (`flipBounds2D`).
 */

import {
  computePdfScaleLayout,
  flipBounds2D,
  worldPointToPdfMm,
  type AxisFlip,
  type Bounds2D,
  type PdfScaleLayout,
} from '@ifc-lite/drawing-2d';

export type SectionAxis = 'down' | 'front' | 'side';

/** Matches the flip `generateExportSVG`/`generateSheetSVG` apply per axis so
 *  the "as displayed" PDF export mirrors the on-screen/SVG orientation:
 *  `front` and `side` sections flip Y (world "up" reads as paper "up" in the
 *  section view), and `side` additionally flips X. `down` (plan) is never
 *  flipped. */
export function axisFlipForSection(axis: SectionAxis): AxisFlip {
  return { flipX: axis === 'side', flipY: axis !== 'down' };
}

/** Compute the page layout for a section PDF export, deriving the page
 *  size/offsets from `bounds` AS FLIPPED for `axis` — see module doc for
 *  why this must not use the un-flipped `bounds` directly. */
export function computePdfSectionLayout(
  bounds: Bounds2D,
  axis: SectionAxis,
  scaleFactor: number,
  marginMm: number
): PdfScaleLayout {
  const flippedBounds = flipBounds2D(bounds, axisFlipForSection(axis));
  return computePdfScaleLayout(flippedBounds, scaleFactor, marginMm);
}

/** Build the world (metres) -> paper (mm) point mapper for a section PDF
 *  export: applies the same per-axis flip used to derive `layout` (via
 *  {@link computePdfSectionLayout}), then the layout's transform. */
export function makeSectionMapPoint(
  axis: SectionAxis,
  layout: PdfScaleLayout
): (x: number, y: number) => { x: number; y: number } {
  const { flipX, flipY } = axisFlipForSection(axis);
  return (x: number, y: number) =>
    worldPointToPdfMm({ x: flipX ? -x : x, y: flipY ? -y : y }, layout.transform);
}
