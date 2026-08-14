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
import type { IfcSourceTransfer } from '@ifc-lite/parser';

import type {
  IdsWorkerRequest,
  IdsWorkerResponse,
} from '@/workers/idsValidation.worker';

export function idsWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}

export interface RunInWorkerArgs {
  /** Raw IFC/STEP bytes from the loaded model's data store. */
  /**
   * The source as an envelope rather than bytes (#2183).
   *
   * A resident source's envelope carries its underlying view, and a
   * SharedArrayBuffer survives structured clone by reference, so on the paths
   * that matter this is the same zero-copy handoff it always was.
   *
   * For a NON-shared buffer this is a simplification rather than a saving:
   * structured clone serializes on the sending thread, so the main thread pays
   * an O(N) write either way. It drops the explicit `slice()`, not the copy.
   *
   * A compressed source crosses as its blocks, so the worker inflates on its
   * own thread. Materializing on this one would allocate the whole file on the
   * render thread, which is the allocation #2183 exists to remove.
   */
  source: IfcSourceTransfer;
  document: IDSDocument;
  schemaVersion: string;
  modelId: string;
  locale: 'en' | 'de' | 'fr';
  includePassingEntities: boolean;
  onProgress?: (progress: ValidationProgress) => void;
}

/**
 * Hand the model bytes + parsed IDS document to the worker and resolve
 * with the validation report. The source crosses as an envelope (#2183); a
 * SharedArrayBuffer-backed source is
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
      source: args.source,
      document: args.document,
      schemaVersion: args.schemaVersion,
      modelId: args.modelId,
      locale: args.locale,
      includePassingEntities: args.includePassingEntities,
    };
    worker.postMessage(request);
  });
}

