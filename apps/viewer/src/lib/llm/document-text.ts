/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
export const MAX_PDF_ATTACHMENT_BYTES = 16_000_000;
export const MAX_DOCUMENT_TEXT_CHARS = 1_000_000;
const MAX_PDF_PAGES = 500;
const MAX_PDF_TEXT_ITEMS = 250_000;
const PDF_EXTRACTION_TIMEOUT_MS = 30_000;

interface PdfTextItem { str: string; hasEOL?: boolean }
interface PdfTextPage {
  streamTextContent(): ReadableStream<{ items: unknown[] }>;
  cleanup(): void;
}
interface PdfTextDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfTextPage>;
}
interface PdfLoadingTask {
  promise: Promise<PdfTextDocument>;
  destroy(): Promise<void>;
}
export interface PdfTextBackend {
  load(data: Uint8Array): PdfLoadingTask;
}
export interface PdfTextOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const browserBackend: PdfTextBackend = {
  load(data) {
    // Lazy loading keeps PDF.js out of the initial viewer bundle. Reuse the
    // canonical browser backend so CMaps and standard fonts are never omitted.
    let task: ReturnType<(typeof import('pdfjs-dist'))['getDocument']> | undefined;
    let cancelled = false;
    const pending = import('../appearance/pdf/browser-backend.js').then(({ browserPdfBackend }) => {
      if (cancelled) throw new DOMException('PDF extraction was cancelled.', 'AbortError');
      const backend = browserPdfBackend();
      task = backend.getDocument({ ...backend.options, data, enableXfa: false, stopAtErrors: true });
      return task.promise;
    });
    return { promise: pending, async destroy() {
      cancelled = true;
      await task?.destroy();
    } };
  },
};

function textItem(value: unknown): value is PdfTextItem {
  return typeof value === 'object' && value !== null && 'str' in value
    && typeof (value as { str?: unknown }).str === 'string';
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('PDF extraction was cancelled.', 'AbortError');
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined, deadline: number): Promise<T> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error('PDF text extraction timed out.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(new Error('PDF text extraction timed out.'))), remaining);
    const onAbort = () => finish(() => reject(abortError(signal!)));
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

async function settleWithin(promise: Promise<unknown>, deadline: number, warning: string): Promise<void> {
  const settled = promise.then(() => true, error => { console.warn(warning, error); return true; });
  const remaining = Math.max(0, Math.min(1_000, deadline - Date.now()));
  if (remaining === 0) return;
  await Promise.race([settled, new Promise(resolve => setTimeout(resolve, remaining))]);
}

export async function extractPdfText(
  file: Blob,
  backend: PdfTextBackend = browserBackend,
  options: PdfTextOptions = {},
): Promise<string> {
  if (file.size === 0) throw new Error('The PDF is empty.');
  if (file.size > MAX_PDF_ATTACHMENT_BYTES) throw new Error(`PDF attachments must be smaller than ${MAX_PDF_ATTACHMENT_BYTES / 1_000_000} MB.`);
  const timeoutMs = options.timeoutMs ?? PDF_EXTRACTION_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('PDF extraction timeout must be positive.');
  const deadline = Date.now() + timeoutMs;
  options.signal?.throwIfAborted();
  const loading = backend.load(new Uint8Array(await file.arrayBuffer()));
  try {
    const document = await waitFor(loading.promise, options.signal, deadline);
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.numPages > MAX_PDF_PAGES) {
      throw new Error(`PDF attachments must contain 1..${MAX_PDF_PAGES} pages.`);
    }
    let result = '';
    let itemCount = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await waitFor(document.getPage(pageNumber), options.signal, deadline);
      const reader = page.streamTextContent().getReader();
      let streamDone = false;
      try {
        let pageText = '';
        while (!streamDone) {
          const chunk = await waitFor(reader.read(), options.signal, deadline);
          streamDone = chunk.done;
          if (chunk.done) break;
          for (const item of chunk.value.items) {
            itemCount += 1;
            if (itemCount > MAX_PDF_TEXT_ITEMS) throw new Error(`PDF text exceeds the ${MAX_PDF_TEXT_ITEMS.toLocaleString()} item work limit.`);
            if ((itemCount & 1023) === 0) {
              options.signal?.throwIfAborted();
              if (Date.now() >= deadline) throw new Error('PDF text extraction timed out.');
            }
            if (!textItem(item)) continue;
            const separator = item.hasEOL ? '\n' : ' ';
            if (result.length + pageText.length + item.str.length + separator.length > MAX_DOCUMENT_TEXT_CHARS) {
              throw new Error(`PDF text exceeds the ${MAX_DOCUMENT_TEXT_CHARS.toLocaleString()} character attachment limit.`);
            }
            pageText += item.str + separator;
          }
        }
        pageText = pageText.trim();
        if (pageText) result += `${result ? '\n\n' : ''}[Page ${pageNumber}]\n${pageText}`;
        if (result.length > MAX_DOCUMENT_TEXT_CHARS) throw new Error(`PDF text exceeds the ${MAX_DOCUMENT_TEXT_CHARS.toLocaleString()} character attachment limit.`);
      } finally {
        if (!streamDone) await settleWithin(reader.cancel(), deadline, '[PDF text] stream cancellation failed');
        page.cleanup();
      }
    }
    if (!result) throw new Error('This PDF contains no machine-readable text. Run OCR on the document, then attach the searchable PDF.');
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') throw new Error('Password-protected PDFs must be unlocked before attachment.');
    throw error;
  } finally {
    await settleWithin(loading.destroy(), deadline, '[PDF text] cleanup failed');
  }
}
