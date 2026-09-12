/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Decoder boundary consumed by canonical Rust preparePdfVectorPage. */
export type PdfAffine = [number, number, number, number, number, number];
export type PdfPageRect = [number, number, number, number];
export type PdfVectorPaint = 'stroke' | 'closeStroke' | 'fill' | 'evenOddFill'
  | 'fillStroke' | 'evenOddFillStroke' | 'closeFillStroke' | 'closeEvenOddFillStroke' | 'endPath';
/** Decoded ExtGState: supported line state plus the entries that taint the scope. */
export interface PdfGraphicsStateOperator {
  kind: 'graphicsState';
  lineWidth: number | null; lineCap: number | null; lineJoin: number | null; miterLimit: number | null;
  dash: [number[], number] | null;
  transparency: string[];
  unsupported: string[];
}
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
  | { kind: 'clip'; evenOdd: boolean }
  | { kind: 'textClip' }
  /** Estimated em-box of one text run in construction space; `invisible` is render mode 3/7. */
  | { kind: 'text'; quad: [number, number, number, number, number, number, number, number]; invisible: boolean }
  /** Each transform maps the unit square in construction space. */
  | { kind: 'image'; transforms: PdfAffine[] }
  | { kind: 'shading' | 'fillPattern' | 'strokePattern' }
  | PdfGraphicsStateOperator
  | { kind: 'groupBegin'; composited: boolean; matrix: PdfAffine | null; bbox: PdfPageRect | null }
  | { kind: 'groupEnd' }
  | { kind: 'formBegin'; matrix: PdfAffine | null; bbox: PdfPageRect | null }
  | { kind: 'formEnd' }
  | { kind: 'annotationBegin'; rect: PdfPageRect | null }
  | { kind: 'annotationEnd' }
  | { kind: 'markedContent'; visible: boolean }
  | { kind: 'endMarkedContent' }
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
  viewBox: PdfPageRect;
  userUnit: number;
  intrinsicRotation: number;
  operations: PdfVectorOperation[];
}
/** Canonical fidelity report from `IfcAPI.preparePdfVectorPage`. */
export interface PdfOmission { kind: string; operatorOrdinal: number; bboxPdf: PdfPageRect | null; visible: boolean }
export interface PdfOmissionSummary { kind: string; count: number; visibleCount: number; bboxPdf: PdfPageRect | null }
export interface PdfFidelityReport {
  sha256: string;
  algorithm: 'ifclite-pdf-fidelity-v1';
  exact: boolean;
  rasterOnly: boolean;
  convertiblePaths: number;
  omittedPaints: number;
  summary: PdfOmissionSummary[];
  omissions: PdfOmission[];
  omissionsTruncated: boolean;
}
export interface PreparedPdfVectorPage {
  requestSha256: string;
  algorithm: 'ifclite-pdf-vector-state-v1';
  pdfSha256: string;
  pageNumber: number;
  calibrationKey: string;
  toleranceMetres: number;
  pageClipPdf: PdfPageRect;
  paths: Array<{ operatorOrdinal: number; paint: PdfVectorPaint; commands: number[] }>;
  fidelity: PdfFidelityReport;
}
