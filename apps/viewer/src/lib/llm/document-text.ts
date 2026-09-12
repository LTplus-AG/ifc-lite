/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
export const MAX_PDF_ATTACHMENT_BYTES = 16_000_000;
export const MAX_DOCUMENT_TEXT_CHARS = 1_000_000;
const MAX_PDF_PAGES = 500;

interface PdfTextItem { str: string; hasEOL?: boolean }
interface PdfTextPage {
  getTextContent(): Promise<{ items: unknown[] }>;
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

const browserBackend: PdfTextBackend = {
  load(data) {
    // Lazy loading keeps PDF.js out of the initial viewer bundle.
    let task: ReturnType<(typeof import('pdfjs-dist'))['getDocument']> | undefined;
    const pending = Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([pdf, worker]) => {
      pdf.GlobalWorkerOptions.workerSrc = worker.default;
      task = pdf.getDocument({ data, enableXfa: false, stopAtErrors: true });
      return task.promise;
    });
    return { promise: pending, async destroy() {
      if (!task) await pending.catch(() => undefined);
      await task?.destroy();
    } };
  },
};

function textItem(value: unknown): value is PdfTextItem {
  return typeof value === 'object' && value !== null && 'str' in value
    && typeof (value as { str?: unknown }).str === 'string';
}

export async function extractPdfText(file: Blob, backend: PdfTextBackend = browserBackend): Promise<string> {
  if (file.size === 0) throw new Error('The PDF is empty.');
  if (file.size > MAX_PDF_ATTACHMENT_BYTES) throw new Error(`PDF attachments must be smaller than ${MAX_PDF_ATTACHMENT_BYTES / 1_000_000} MB.`);
  const loading = backend.load(new Uint8Array(await file.arrayBuffer()));
  try {
    const document = await loading.promise;
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.numPages > MAX_PDF_PAGES) {
      throw new Error(`PDF attachments must contain 1..${MAX_PDF_PAGES} pages.`);
    }
    let result = '';
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        let pageText = '';
        for (const item of content.items) {
          if (!textItem(item)) continue;
          const separator = item.hasEOL ? '\n' : ' ';
          if (result.length + pageText.length + item.str.length + separator.length > MAX_DOCUMENT_TEXT_CHARS) {
            throw new Error(`PDF text exceeds the ${MAX_DOCUMENT_TEXT_CHARS.toLocaleString()} character attachment limit.`);
          }
          pageText += item.str + separator;
        }
        pageText = pageText.trim();
        if (pageText) result += `${result ? '\n\n' : ''}[Page ${pageNumber}]\n${pageText}`;
        if (result.length > MAX_DOCUMENT_TEXT_CHARS) throw new Error(`PDF text exceeds the ${MAX_DOCUMENT_TEXT_CHARS.toLocaleString()} character attachment limit.`);
      } finally {
        page.cleanup();
      }
    }
    if (!result) throw new Error('This PDF contains no machine-readable text. Run OCR on the document, then attach the searchable PDF.');
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') throw new Error('Password-protected PDFs must be unlocked before attachment.');
    throw error;
  } finally {
    await loading.destroy().catch(error => console.warn('[PDF text] cleanup failed', error));
  }
}
