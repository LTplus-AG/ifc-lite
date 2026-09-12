/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Saved documents (#4594), the way dashboards are saved: localStorage,
 * validated on the way in, and the `.ifclite-document.json` file a document
 * is shared as — the template you re-open on the next revision of the model.
 */
import { downloadFile, sanitizeFilename } from '../export/download.js';
import { validateDocumentSpec, type DocumentSpec } from './types.js';

const STORAGE_KEY = 'ifc-lite-documents';

export function loadDocuments(): DocumentSpec[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const kept: DocumentSpec[] = [];
    for (const entry of parsed) {
      const errors = validateDocumentSpec(entry);
      if (errors.length === 0) kept.push(entry as DocumentSpec);
      else console.warn('[Documents] Dropping an invalid saved document', errors);
    }
    return kept;
  } catch (err) {
    console.warn('[Documents] Failed to load saved documents', err);
    return [];
  }
}

export function saveDocuments(documents: readonly DocumentSpec[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(documents));
  } catch (err) {
    console.warn('[Documents] Failed to save documents to localStorage', err);
  }
}

/** The file a document is shared as. */
export const DOCUMENT_FILE_SUFFIX = '.ifclite-document.json';

export function exportDocument(document: DocumentSpec): void {
  downloadFile(JSON.stringify(document, null, 2), `${sanitizeFilename(document.name, { fallback: 'document' })}${DOCUMENT_FILE_SUFFIX}`, 'application/json');
}

export const freshDocumentId = (): string => `document-${crypto.randomUUID()}`;
export const freshBlockId = (): string => `block-${crypto.randomUUID()}`;

/**
 * Parse a document file: validated, and re-identified so the imported copy
 * never collides with the document it was exported from. Bindings are kept
 * as written — that is the point of a template.
 */
export function parseDocumentFile(text: string): DocumentSpec {
  const parsed: unknown = JSON.parse(text);
  const errors = validateDocumentSpec(parsed);
  if (errors.length > 0) {
    throw new Error(`Not a document file: ${errors.slice(0, 3).map((e) => `${e.path || '/'} ${e.message}`).join('; ')}`);
  }
  const spec = parsed as DocumentSpec;
  return { ...spec, id: freshDocumentId(), blocks: spec.blocks.map((b) => ({ ...b, id: freshBlockId() })) };
}

export function importDocument(file: File): Promise<DocumentSpec> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(parseDocumentFile(reader.result as string));
      } catch (err) {
        reject(err instanceof Error ? err : new Error('Failed to parse the document file'));
      }
    };
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsText(file);
  });
}

/** Read an image file into the data URL an image block stores (PNG/JPEG only, capped so a file stays shareable). */
export const IMAGE_MAX_BYTES = 1_000_000;

export function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      reject(new Error('Only PNG and JPEG images can be placed in a document'));
      return;
    }
    if (file.size > IMAGE_MAX_BYTES) {
      reject(new Error(`Image is ${(file.size / 1_000_000).toFixed(1)} MB; the limit is 1 MB so the document file stays shareable`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}
