/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationKey } from '@/i18n';

export type DrawingExportFormat = 'pdf' | 'dxf';
export type DrawingExportOmission = 'markups' | 'otherCutDimensions' | 'rasterReferences' | 'requestedScale';

export interface DrawingExportContent {
  /** Markup kinds the PDF and DXF writers do not draw. Dimensions are not among them: those on the current cut export everywhere. */
  markupCounts: Readonly<{ measurements: number; areas: number; texts: number; clouds: number }>;
  /** Dimensions drawn on another cut (`isDimensionOnPlane`), which every export leaves out. */
  otherCutDimensionCount?: number;
  /** Count only underlays the drawing actually shows (opacity > 0). */
  visibleUnderlayCount: number;
  /** Visible, available, non-edge-on PDF/image references. DXF has no raster embedding. */
  visibleRasterReferenceCount?: number;
  /** Null unless a sheet is enabled and present. Sheet PDF embeds underlays. */
  sheetScale: number | null;
  requestedScale?: number;
}

export const DRAWING_OMISSION_LABEL_KEYS = {
  markups: 'section2d.export.omission.markups',
  otherCutDimensions: 'section2d.export.omission.otherCutDimensions',
  rasterReferences: 'section2d.export.omission.rasterReferences',
  requestedScale: 'section2d.export.omission.requestedScale',
} as const satisfies Record<DrawingExportOmission, TranslationKey>;

/** #6615: vector references export everywhere; only DXF omits raster references. Dimensions on the current cut export everywhere; those from another cut nowhere. */
export function drawingExportOmissions(
  content: DrawingExportContent,
  format: DrawingExportFormat,
): DrawingExportOmission[] {
  const omissions: DrawingExportOmission[] = [];
  const { markupCounts, otherCutDimensionCount = 0, visibleRasterReferenceCount = 0, sheetScale, requestedScale } = content;
  if (markupCounts.measurements + markupCounts.areas + markupCounts.texts + markupCounts.clouds > 0) {
    omissions.push('markups');
  }
  if (otherCutDimensionCount > 0) omissions.push('otherCutDimensions');
  if (visibleRasterReferenceCount > 0 && format === 'dxf') {
    omissions.push('rasterReferences');
  }
  if (format === 'pdf' && sheetScale !== null && requestedScale !== undefined && requestedScale !== sheetScale) {
    omissions.push('requestedScale');
  }
  return omissions;
}
