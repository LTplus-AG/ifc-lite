/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PdfAppearanceSource } from './source-document.js';

// Session originals only. IFCZIP carries retained raster derivatives, never these PDF bytes.
const documents = new Map<string, PdfAppearanceSource>();
export function registerPdfDocument(document: PdfAppearanceSource): string {
  const key = `pdf:${crypto.randomUUID()}`;
  documents.set(key, document);
  return key;
}
export function getPdfDocument(key: string): PdfAppearanceSource | undefined { return documents.get(key); }
export function removePdfDocument(key: string): void {
  const document = documents.get(key);
  documents.delete(key);
  document?.dispose();
}
