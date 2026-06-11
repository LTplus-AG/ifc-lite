/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main-thread client for the IDS validation worker.
 *
 * Spawns the worker per run (validation is infrequent and the worker
 * re-parses the model, so a long-lived instance would only pin memory),
 * streams progress back to the caller, and resolves with the report.
 * The caller falls back to in-process validation when `isSupported()`
 * is false or the worker rejects.
 */

import type {
  IDSDocument,
  IDSValidationReport,
  ValidationProgress,
} from '@ifc-lite/ids';
import type {
  IdsWorkerRequest,
  IdsWorkerResponse,
} from '@/workers/idsValidation.worker';

export function idsWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}

export interface RunInWorkerArgs {
  /** Raw IFC/STEP bytes from the loaded model's data store. */
  source: Uint8Array;
  document: IDSDocument;
  schemaVersion: string;
  modelId: string;
  locale: 'en' | 'de' | 'fr';
  includePassingEntities: boolean;
  onProgress?: (progress: ValidationProgress) => void;
}

/**
 * Hand the model bytes + parsed IDS document to the worker and resolve
 * with the validation report. A SharedArrayBuffer-backed source is
 * shared zero-copy; a plain ArrayBuffer is copied and transferred so
 * the main-thread store is never detached.
 */
export function runValidationInWorker(
  args: RunInWorkerArgs
): Promise<IDSValidationReport> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(
        new URL('../../workers/idsValidation.worker.ts', import.meta.url),
        { type: 'module' }
      );
    } catch (err) {
      reject(
        new Error(
          `Failed to spawn IDS worker: ${err instanceof Error ? err.message : String(err)}`
        )
      );
      return;
    }

    const id = Date.now();
    const { buffer, transfer } = prepareSource(args.source);

    const settle = (fn: () => void) => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      fn();
    };

    worker.onmessage = (event: MessageEvent<IdsWorkerResponse>) => {
      const msg = event.data;
      if (!msg || msg.id !== id) return;
      switch (msg.type) {
        case 'progress':
          args.onProgress?.(msg.progress);
          return;
        case 'complete':
          settle(() => resolve(msg.report));
          return;
        case 'error':
          settle(() => reject(new Error(msg.message)));
          return;
      }
    };

    worker.onerror = (event) => {
      settle(() => reject(new Error(event.message || 'IDS worker crashed')));
    };
    worker.onmessageerror = () => {
      settle(() => reject(new Error('IDS worker message deserialization failed')));
    };

    const request: IdsWorkerRequest = {
      type: 'validate',
      id,
      source: buffer,
      document: args.document,
      schemaVersion: args.schemaVersion,
      modelId: args.modelId,
      locale: args.locale,
      includePassingEntities: args.includePassingEntities,
    };
    worker.postMessage(request, transfer);
  });
}

/**
 * Resolve the exact source bytes into a worker-postable buffer.
 * SharedArrayBuffer is shared by reference (zero copy); a plain
 * ArrayBuffer (or a partial view) is copied into a fresh, transferable
 * ArrayBuffer so the caller's store keeps its bytes.
 */
function prepareSource(source: Uint8Array): {
  buffer: ArrayBuffer | SharedArrayBuffer;
  transfer: Transferable[];
} {
  const sharedAvailable = typeof SharedArrayBuffer !== 'undefined';
  if (
    sharedAvailable &&
    source.buffer instanceof SharedArrayBuffer &&
    source.byteOffset === 0 &&
    source.byteLength === source.buffer.byteLength
  ) {
    // Shared by reference — no copy, the worker only reads it.
    return { buffer: source.buffer, transfer: [] };
  }
  // Copy the exact bytes; transfer the copy (never the original).
  const copy = source.slice();
  return { buffer: copy.buffer, transfer: [copy.buffer] };
}
