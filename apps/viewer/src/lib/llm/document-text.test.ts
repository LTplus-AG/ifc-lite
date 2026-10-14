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
        return { streamTextContent() { return new ReadableStream({ start(controller) {
          controller.enqueue({ items: pages[pageNumber - 1] }); controller.close();
        } }); }, cleanup() { cleaned.push(pageNumber); } };
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
  const excessiveWork = backend([Array(250_001).fill({ type: 'layout-only' })]);
  await assert.rejects(extractPdfText(new Blob(['%PDF item bomb']), excessiveWork.value), /item work limit/);
  assert.equal(excessiveWork.destroyed(), true);
});

test('#4177 bounds a silent parser by cancellation and a deadline', async () => {
  let destroyed = 0;
  const silent: PdfTextBackend = { load() { return {
    promise: new Promise(() => undefined), async destroy() { destroyed += 1; },
  }; } };
  const controller = new AbortController();
  const cancelled = extractPdfText(new Blob(['%PDF hangs']), silent, { signal: controller.signal });
  controller.abort(new Error('upload cancelled'));
  await assert.rejects(cancelled, /upload cancelled/);
  await assert.rejects(extractPdfText(new Blob(['%PDF hangs']), silent, { timeoutMs: 5 }), /timed out/);
  assert.equal(destroyed, 2);
});

test('#4177 a nonsettling destroy cannot extend the overall deadline', async (t) => {
  // On a mocked clock rather than a wall-clock budget (< 100 ms), which a
  // loaded runner could exceed with correct code. Stricter, too: the
  // rejection must land at the deadline itself, with no further clock
  // advance, so a cleanup that waited even 1 ms of its own fails here.
  // setImmediate stays real: it only drains promise continuations.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
  let loaded = false;
  const stuck: PdfTextBackend = { load() { loaded = true; return {
    promise: new Promise(() => undefined), destroy: () => new Promise(() => undefined),
  }; } };
  let outcome: unknown;
  void extractPdfText(new Blob(['%PDF hangs']), stuck, { timeoutMs: 5 }).then(
    () => { outcome = 'resolved'; },
    (error: unknown) => { outcome = error; },
  );
  // The deadline timer is armed in the same continuation that calls load().
  for (let i = 0; i < 1_000 && !loaded; i++) await turn();
  assert.ok(loaded, 'the extraction reached the backend');
  t.mock.timers.tick(5);
  for (let i = 0; i < 20 && outcome === undefined; i++) await turn();
  assert.ok(outcome instanceof Error, 'cleanup must not outlive the extraction deadline');
  assert.match(outcome.message, /timed out/);
});

test('#4177 destroys the PDF task when text extraction fails', async () => {
  let destroyed = false;
  const broken: PdfTextBackend = { load() { return { promise: Promise.reject(Object.assign(new Error('password'), { name: 'PasswordException' })), async destroy() { destroyed = true; } }; } };
  await assert.rejects(extractPdfText(new Blob(['%PDF locked']), broken), /must be unlocked/);
  assert.equal(destroyed, true);
});
