/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PdfRasterRecipe } from './types.js';
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid PDF recipe.');
  return value as Record<string, unknown>;
}
function number(value: unknown, positive = false, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || positive && value <= 0 || integer && !Number.isSafeInteger(value)) {
    throw new Error('Invalid PDF recipe measurement.');
  }
  return value;
}
function array(value: unknown, length: number): number[] {
  if (!Array.isArray(value) || value.length !== length) throw new Error('Invalid PDF recipe coordinates.');
  return value.map(n => number(n));
}
function pair(value: unknown): [number, number] { const a = array(value, 2); return [a[0], a[1]]; }
function affine(value: unknown): [number, number, number, number, number, number] {
  const a = array(value, 6); return [a[0], a[1], a[2], a[3], a[4], a[5]];
}
function rect(value: unknown): [number, number, number, number] { const a = array(value, 4); return [a[0], a[1], a[2], a[3]]; }
export function ownPdfRasterRecipe(value: unknown): PdfRasterRecipe {
  const v = record(value), p = record(v.page);
  if (v.rotation !== 0 && v.rotation !== 90 && v.rotation !== 180 && v.rotation !== 270) throw new Error('Unsupported PDF rotation.');
  return { page: { pageNumber: number(p.pageNumber, true, true), viewBox: rect(p.viewBox), userUnit: number(p.userUnit, true),
    intrinsicRotation: number(p.intrinsicRotation), widthPoints: number(p.widthPoints, true), heightPoints: number(p.heightPoints, true), pdfToPage: affine(p.pdfToPage) },
    rotation: v.rotation, cropPoints: rect(v.cropPoints), requestedDpi: number(v.requestedDpi, true), effectiveDpi: number(v.effectiveDpi, true),
    pixelWidth: number(v.pixelWidth, true, true), pixelHeight: number(v.pixelHeight, true, true),
    paperSizeMetres: pair(v.paperSizeMetres), pixelToPdf: affine(v.pixelToPdf) };
}
