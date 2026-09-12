/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractPdfText, MAX_DOCUMENT_TEXT_CHARS, type PdfTextBackend } from './document-text';

function backend(pages: unknown[][]): { value: PdfTextBackend; cleaned: number[]; destroyed: () => boolean } {
  const cleaned: number[] = [];
  let didDestroy = false;
  return {
    cleaned,
    destroyed: () => didDestroy,
    value: { load() { return {
      promise: Promise.resolve({ numPages: pages.length, async getPage(pageNumber) {
        return { async getTextContent() { return { items: pages[pageNumber - 1] }; }, cleanup() { cleaned.push(pageNumber); } };
      } }),
      async destroy() { didDestroy = true; },
    }; } },
  };
}

test('#4177 extracts ordered, page-labelled PDF text and disposes every page', async () => {
  const fake = backend([[{ str: 'Fire', hasEOL: false }, { str: 'rating', hasEOL: true }, { str: 'EI60' }], [{ str: 'Door schedule' }]]);
  const text = await extractPdfText(new Blob(['%PDF fixture']), fake.value);
  assert.equal(text, '[Page 1]\nFire rating\nEI60\n\n[Page 2]\nDoor schedule');
  assert.deepEqual(fake.cleaned, [1, 2]);
  assert.equal(fake.destroyed(), true);
});

test('#4177 extracts text through the real PDF.js parser', async () => {
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const realBackend: PdfTextBackend = { load(data) {
    const task = pdf.getDocument({ data, enableXfa: false, stopAtErrors: true });
    return { promise: task.promise, destroy: () => task.destroy() };
  } };
  const fixture = await readFile(new URL('../../../../../docs/architecture/evidence/pdf-fidelity-report/control-text-accepted.pdf', import.meta.url));
  const text = await extractPdfText(new Blob([fixture]), realBackend);
  assert.match(text, /^\[Page 1\]/);
  assert.match(text, /Visible text/);
});

test('#4177 refuses scanned/no-text and oversized PDFs without inventing OCR', async () => {
  const scanned = backend([[{ type: 'image' }]]);
  await assert.rejects(extractPdfText(new Blob(['%PDF image']), scanned.value), /no machine-readable text.*OCR/);
  assert.deepEqual(scanned.cleaned, [1]);
  assert.equal(scanned.destroyed(), true);
  const oversized = new Blob();
  Object.defineProperty(oversized, 'size', { value: 16_000_001 });
  await assert.rejects(extractPdfText(oversized, scanned.value), /smaller than 16 MB/);
  const inflated = backend([[{ str: 'x'.repeat(MAX_DOCUMENT_TEXT_CHARS + 1) }]]);
  await assert.rejects(extractPdfText(new Blob(['%PDF compressed']), inflated.value), /character attachment limit/);
  assert.equal(inflated.destroyed(), true);
});

test('#4177 destroys the PDF task when text extraction fails', async () => {
  let destroyed = false;
  const broken: PdfTextBackend = { load() { return { promise: Promise.reject(Object.assign(new Error('password'), { name: 'PasswordException' })), async destroy() { destroyed = true; } }; } };
  await assert.rejects(extractPdfText(new Blob(['%PDF locked']), broken), /must be unlocked/);
  assert.equal(destroyed, true);
});
