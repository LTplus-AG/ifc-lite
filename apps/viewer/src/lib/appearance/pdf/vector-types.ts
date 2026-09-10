/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Decoder boundary consumed by canonical Rust preparePdfVectorPage. */
export type PdfAffine = [number, number, number, number, number, number];
export type PdfVectorPaint = 'stroke' | 'closeStroke' | 'fill' | 'evenOddFill'
  | 'fillStroke' | 'evenOddFillStroke' | 'closeFillStroke' | 'closeEvenOddFillStroke' | 'endPath';
export type PdfVectorOperator =
  | { kind: 'save' | 'restore' }
  | { kind: 'transform'; matrix: PdfAffine }
  | { kind: 'fillColor' | 'strokeColor'; rgb: [number, number, number] }
  | { kind: 'lineWidth'; width: number }
  | { kind: 'lineCap'; cap: number }
  | { kind: 'lineJoin'; join: number }
  | { kind: 'miterLimit'; limit: number }
  | { kind: 'dash'; lengths: number[]; phase: number }
  | { kind: 'path'; paint: PdfVectorPaint; commands: number[] }
  | { kind: 'unsupported'; operator: string };
export interface PdfVectorOperation { ordinal: number; operation: PdfVectorOperator }
export interface PdfVectorRequest {
  pageNumber: number;
  /** Native PDF space -> calibrated model plane metres, including chosen page recipe. */
  modelMetresFromPdf: PdfAffine;
  calibrationKey: string;
  toleranceMetres: number;
}
export interface PdfVectorPage extends PdfVectorRequest {
  pdfSha256: string;
  decoderVersion: string;
  viewBox: [number, number, number, number];
  userUnit: number;
  intrinsicRotation: number;
  operations: PdfVectorOperation[];
}
