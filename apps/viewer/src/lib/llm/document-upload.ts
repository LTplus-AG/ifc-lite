/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { FileAttachment } from './types.js';
import { extractPdfText, type PdfTextOptions } from './document-text.js';

type Extractor = (file: Blob, options: PdfTextOptions) => Promise<string>;

export interface DocumentUploadGate {
  extract(file: Blob): Promise<string>;
  cancel(): void;
}

export function createDocumentUploadGate(
  extractor: Extractor = (file, options) => extractPdfText(file, undefined, options),
): DocumentUploadGate {
  let generation = 0;
  const active = new Set<AbortController>();
  return {
    async extract(file) {
      const ownGeneration = generation;
      const controller = new AbortController();
      active.add(controller);
      try {
        const text = await extractor(file, { signal: controller.signal });
        if (generation !== ownGeneration) throw new DOMException('PDF upload became stale.', 'AbortError');
        return text;
      } finally {
        active.delete(controller);
      }
    },
    cancel() {
      generation += 1;
      for (const controller of active) controller.abort(new DOMException('PDF upload was cancelled.', 'AbortError'));
      active.clear();
    },
  };
}

export async function attachPdfDocument(
  file: File,
  gate: DocumentUploadGate,
  add: (attachment: FileAttachment) => void,
): Promise<void> {
  const textContent = await gate.extract(file);
  add({ id: crypto.randomUUID(), name: file.name, type: 'application/pdf', size: file.size, textContent });
}
