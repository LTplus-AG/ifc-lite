/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PdfAppearanceSource } from './source-document.js';

interface DocumentEntry { document: PdfAppearanceSource; source: boolean; owners: Set<string> }
// Session originals only. Reference manifests retain provenance, never PDF bytes/passwords.
const documents = new Map<string, DocumentEntry>();
function releaseUnused(key: string, entry: DocumentEntry): void {
  if (entry.source || entry.owners.size) return;
  documents.delete(key); entry.document.dispose();
}
export function registerPdfDocument(document: PdfAppearanceSource): string {
  const key = `pdf:${crypto.randomUUID()}`;
  documents.set(key, { document, source: true, owners: new Set() });
  return key;
}
export function getPdfDocument(key: string): PdfAppearanceSource | undefined { return documents.get(key)?.document; }
export function findPdfDocument(digest: string): { key: string; document: PdfAppearanceSource } | undefined {
  for (const [key, entry] of documents) if (entry.document.id === digest) return { key, document: entry.document };
}
/** Source removal must not invalidate a committed reference or its Undo history. */
export function removePdfDocument(key: string): void {
  const entry = documents.get(key);
  if (!entry) return;
  entry.source = false; releaseUnused(key, entry);
}
export function retainPdfDocument(digest: string, owner: string): boolean {
  const found = findPdfDocument(digest);
  if (!found) return false;
  documents.get(found.key)!.owners.add(owner); return true;
}
export function releasePdfDocument(digest: string, owner: string): void {
  for (const [key, entry] of documents) if (entry.document.id === digest) {
    entry.owners.delete(owner); releaseUnused(key, entry);
  }
}
