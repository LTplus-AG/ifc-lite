/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Line weight + dash pattern for one `DrawingLine` in a PDF export (#2042).
 *
 * DEFECT CLASS: two PDF writers that each hand-roll the same `switch` on
 * `line.category`. The section PDF (`useDrawingExport.ts`) had the only copy;
 * the to-scale 3D-view PDF is a second writer of the SAME drawing model, and a
 * second inline switch would drift the moment either one gains a category or
 * changes a weight — printing the same model at two different line hierarchies
 * from one app, with nothing failing. Both writers now read this table.
 *
 * The values are the shipped section-PDF ones, moved verbatim: this extraction
 * is behaviour-preserving, so the section PDF's bytes must not change.
 *
 * mm on paper, not world units — line weights are a drafting convention and do
 * NOT scale with the drawing's 1:N factor.
 */

import type { LineCategory, VisibilityState } from '@ifc-lite/drawing-2d';

/** Stroke style for one line, in PDF page units (mm). */
export interface PdfLineStyle {
  /** Stroke width in mm on paper. */
  lineWidthMm: number;
  /** jsPDF dash pattern in mm. Empty means a solid stroke. */
  dash: number[];
}

/** Base stroke width per category, in mm on paper. */
const BASE_LINE_WIDTH_MM: Readonly<Record<LineCategory, number>> = {
  // Matches the cut-polygon outline stroke width; category `cut` lines are the
  // fallback path for entities whose polygon reconstruction failed (#2119).
  cut: 0.5,
  hidden: 0.18,
  silhouette: 0.35,
  crease: 0.18,
  boundary: 0.25,
  annotation: 0.13,
  projection: 0.25,
};

/** Width for a category the table does not know (kept from the old `default:`). */
const FALLBACK_LINE_WIDTH_MM = 0.25;

/** The one dash pattern used for anything occluded, in mm. */
const HIDDEN_DASH_MM: readonly number[] = [1, 0.6];

/**
 * Weight and dash for a drawing line.
 *
 * `visibility: 'hidden'` (the hidden-line pass found the segment occluded)
 * dashes the line and thins it to 70% — applied on top of the category weight,
 * so an occluded silhouette still reads heavier than an occluded crease.
 *
 * Returns a fresh `dash` array on every call: jsPDF's `setLineDashPattern`
 * keeps the array the caller hands it, so a shared instance could be mutated
 * out from under a previous stroke.
 */
export function pdfLineStyleFor(
  category: LineCategory,
  visibility: VisibilityState,
): PdfLineStyle {
  const base = BASE_LINE_WIDTH_MM[category] ?? FALLBACK_LINE_WIDTH_MM;
  const dashed = category === 'hidden' || visibility === 'hidden';
  return {
    lineWidthMm: visibility === 'hidden' ? base * 0.7 : base,
    dash: dashed ? [...HIDDEN_DASH_MM] : [],
  };
}
