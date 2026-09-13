/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { FileAttachment } from './types.js';
import { extractPdfText, type PdfTextOptions } from './document-text.js';

type Extractor = (file: Blob, options: PdfTextOptions) => Promise<string>;

export interface DocumentUploadBatch {
  current(): boolean;
  run<T>(file: Blob, commit: (text: string) => T): Promise<T>;
}
export interface DocumentUploadGate {
  begin(): DocumentUploadBatch;
  cancel(): void;
}

export function shouldContinueDocumentUploadBatch(error: unknown): boolean {
  return !(error instanceof Error && error.name === 'AbortError');
}

export function createDocumentUploadGate(
  extractor: Extractor = (file, options) => extractPdfText(file, undefined, options),
): DocumentUploadGate {
  let generation = 0;
  const active = new Set<AbortController>();
  return {
    begin() {
      const ownGeneration = generation;
      const current = () => generation === ownGeneration;
      return { current, async run(file, commit) {
        if (!current()) throw new DOMException('PDF upload became stale.', 'AbortError');
        const controller = new AbortController();
        active.add(controller);
        try {
          const text = await extractor(file, { signal: controller.signal });
          if (!current()) throw new DOMException('PDF upload became stale.', 'AbortError');
          return commit(text);
        } finally {
          active.delete(controller);
        }
      } };
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
  batch: DocumentUploadBatch,
  add: (attachment: FileAttachment) => void,
): Promise<void> {
  await batch.run(file, textContent => {
    add({ id: crypto.randomUUID(), name: file.name, type: 'application/pdf', size: file.size, textContent });
  });
}
