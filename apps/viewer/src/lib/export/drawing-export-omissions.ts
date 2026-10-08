/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationKey } from '@/i18n';

export type DrawingExportFormat = 'pdf' | 'dxf';
export type DrawingExportOmission = 'markups' | 'rasterReferences' | 'requestedScale';

export interface DrawingExportContent {
  markupCounts: Readonly<{ measurements: number; areas: number; texts: number; clouds: number }>;
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
  rasterReferences: 'section2d.export.omission.rasterReferences',
  requestedScale: 'section2d.export.omission.requestedScale',
} as const satisfies Record<DrawingExportOmission, TranslationKey>;

/** #6615: vector references export everywhere; only DXF omits raster references. */
export function drawingExportOmissions(
  content: DrawingExportContent,
  format: DrawingExportFormat,
): DrawingExportOmission[] {
  const omissions: DrawingExportOmission[] = [];
  const { markupCounts, visibleRasterReferenceCount = 0, sheetScale, requestedScale } = content;
  if (markupCounts.measurements + markupCounts.areas + markupCounts.texts + markupCounts.clouds > 0) {
    omissions.push('markups');
  }
  if (visibleRasterReferenceCount > 0 && format === 'dxf') {
    omissions.push('rasterReferences');
  }
  if (format === 'pdf' && sheetScale !== null && requestedScale !== undefined && requestedScale !== sheetScale) {
    omissions.push('requestedScale');
  }
  return omissions;
}
