/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationKey } from '@/i18n';

export type DrawingExportFormat = 'pdf' | 'dxf';
export type DrawingExportOmission = 'markups' | 'underlays' | 'requestedScale';

export interface DrawingExportContent {
  markupCounts: Readonly<{ measurements: number; areas: number; texts: number; clouds: number }>;
  /** Count only underlays the drawing actually shows (opacity > 0). */
  visibleUnderlayCount: number;
  /** Null unless a sheet is enabled and present. Sheet PDF embeds underlays. */
  sheetScale: number | null;
  requestedScale?: number;
}

export const DRAWING_OMISSION_LABEL_KEYS = {
  markups: 'section2d.export.omission.markups',
  underlays: 'section2d.export.omission.underlays',
  requestedScale: 'section2d.export.omission.requestedScale',
} as const satisfies Record<DrawingExportOmission, TranslationKey>;

/** Describe content excluded by the current writers without changing their bytes (#5850). */
export function drawingExportOmissions(
  content: DrawingExportContent,
  format: DrawingExportFormat,
): DrawingExportOmission[] {
  const omissions: DrawingExportOmission[] = [];
  const { markupCounts, visibleUnderlayCount, sheetScale, requestedScale } = content;
  if (markupCounts.measurements + markupCounts.areas + markupCounts.texts + markupCounts.clouds > 0) {
    omissions.push('markups');
  }
  // Sheet PDF rasterizes the sheet SVG, which includes visible DXF underlays.
  // The vector PDF and DXF writers do not include them.
  if (visibleUnderlayCount > 0 && (format === 'dxf' || sheetScale === null)) {
    omissions.push('underlays');
  }
  if (format === 'pdf' && sheetScale !== null && requestedScale !== undefined && requestedScale !== sheetScale) {
    omissions.push('requestedScale');
  }
  return omissions;
}
