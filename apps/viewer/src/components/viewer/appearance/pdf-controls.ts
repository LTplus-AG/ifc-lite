/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PdfQuarterTurn, PdfRect } from '@/lib/appearance/pdf/types.js';

/** Presentation contract; the controller owns PDF handles, raster jobs and source leases. */
export interface AppearancePdfControls {
  /** Changes when the selected document changes; used to clear incomplete local edits. */
  documentId: string;
  documentName: string;
  pageCount: number;
  pageNumber: number;
  rotation: PdfQuarterTurn;
  /** Visible page extent AFTER additional rotation, in physical PDF points. */
  pageSizePoints: readonly [number, number];
  /** [left,top,width,height], same rotated physical-point frame as the PDF service. */
  cropPoints: PdfRect;
  /** Full rotated page, NOT the cropped derived image. URL lifetime belongs to controller. */
  pagePreviewUrl?: string;
  requestedDpi: number;
  effectiveDpi?: number;
  busy?: boolean;
  error?: string;
  onPageChange(pageNumber: number): void;
  onRotationChange(rotation: PdfQuarterTurn): void;
  onCropChange(cropPoints: PdfRect): void;
  onDpiChange(dpi: number): void;
}

export interface AppearancePdfPasswordPrompt {
  documentName: string;
  incorrect?: boolean;
  busy?: boolean;
  onSubmit(password: string): void;
  onCancel?(): void;
}
