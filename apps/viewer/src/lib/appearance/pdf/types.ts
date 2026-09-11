/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PdfVectorPage, PdfVectorRequest } from './vector-types.js';
export type PdfQuarterTurn = 0 | 90 | 180 | 270;
export type PdfRect = [number, number, number, number];
export interface PdfPageInfo {
  pageNumber: number;
  /** PDF user-space box [xMin,yMin,xMax,yMax], before UserUnit and rotation. */
  viewBox: PdfRect;
  userUnit: number;
  intrinsicRotation: number;
  /** Rotated visible page extent in physical points (1/72 inch). */
  widthPoints: number;
  heightPoints: number;
  pdfToPage: number[];
}
export interface PdfRasterRequest {
  pageNumber: number;
  /** Additional clockwise rotation relative to the document page. */
  rotation?: PdfQuarterTurn;
  /** [left,top,width,height] in the rotated page's physical points. */
  cropPoints?: PdfRect;
  dpi?: number;
  maxPixels?: number;
  maxDimension?: number;
}
export interface PdfRasterRecipe {
  page: PdfPageInfo;
  rotation: PdfQuarterTurn;
  cropPoints: PdfRect;
  requestedDpi: number;
  effectiveDpi: number;
  pixelWidth: number;
  pixelHeight: number;
  /** Physical PAPER crop size only. Drawing/model calibration is separate. */
  paperSizeMetres: [number, number];
  /** Affine [a,b,c,d,e,f], raster pixels → unrotated native PDF user space. */
  pixelToPdf: number[];
}
export type PdfErrorCode =
  | 'password-required'
  | 'password-incorrect'
  | 'invalid-pdf'
  | 'budget'
  | 'unsupported'
  | 'cancelled'
  | 'render';
export class PdfAppearanceError extends Error {
  constructor(
    readonly code: PdfErrorCode,
    message: string,
  ) {
    super(message);
    this.name = code === 'cancelled' ? 'AbortError' : 'PdfAppearanceError';
  }
}
export type PdfJob =
  | { kind: 'inspect'; pageNumber?: number }
  | { kind: 'raster'; request: PdfRasterRequest }
  | { kind: 'vectors'; request: PdfVectorRequest };
export type PdfJobResult =
  | { kind: 'inspect'; pageCount: number; page: PdfPageInfo }
  | { kind: 'raster'; png: Uint8Array; recipe: PdfRasterRecipe }
  | { kind: 'vectors'; page: PdfVectorPage };
export interface PdfWorkerRequest {
  id: number;
  source: Uint8Array;
  password?: string;
  job: PdfJob;
}
export type PdfWorkerResponse =
  | { id: number; result: PdfJobResult }
  | { id: number; error: { code: PdfErrorCode; message: string } };
export const PDF_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxPages: 2000,
  maxPixels: 16 * 1024 * 1024,
  maxDimension: 8192,
  timeoutMs: 60000,
});
