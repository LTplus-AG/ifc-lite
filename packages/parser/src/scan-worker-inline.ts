/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inline Web Worker for IFC entity scanning.
 *
 * Moves the 7-8s entity scanning off the main thread so geometry streaming
 * and UI remain responsive. The scanning logic is embedded as a string (see
 * `scan-worker-source.ts`) to avoid bundler/import issues with Web Workers.
 */

import { WORKER_CODE } from './scan-worker-source.js';

export interface EntityRefWorkerResult {
  expressId: number;
  type: string;
  byteOffset: number;
  byteLength: number;
  lineNumber: number;
}

/** What one worker scan produced: the records it accepted, and how many it
 *  refused for an out-of-contract express id (#3395). The second half is not
 *  decoration — a guard that acts without reporting turns a corrupted index
 *  into a silently short one, which reads exactly like success. */
export interface EntityScanWorkerResult {
  refs: EntityRefWorkerResult[];
  oversizedIdCount: number;
}


export { WORKER_CODE };

let workerBlobUrl: string | null = null;

function getWorkerBlobUrl(): string {
  if (!workerBlobUrl) {
    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
    workerBlobUrl = URL.createObjectURL(blob);
  }
  return workerBlobUrl;
}

/**
 * Scan IFC entities in a Web Worker (non-blocking).
 * Sends a structured clone of the buffer to the worker (browser handles copy).
 * Caller keeps the original buffer intact for columnar parsing.
 */
export function scanEntitiesInWorker(
  buffer: ArrayBuffer | SharedArrayBuffer,
): Promise<EntityScanWorkerResult> {
  return new Promise((resolve, reject) => {
    // Declared outside the try so the catch block below can still reach it:
    // `new Worker(...)` can succeed and a later step in this same try (e.g.
    // `postMessage` on an already-detached buffer, or under memory pressure
    // while cloning a large one) can still throw. A `worker` scoped to the
    // try block would be unreachable from `catch`, leaking the spawned
    // worker — construct-then-fail with no handle to dispose it.
    let worker: Worker | undefined;
    try {
      worker = new Worker(getWorkerBlobUrl());
      // TS loses the `worker` narrowing inside these closures (a captured
      // `let` is re-widened to `Worker | undefined` at the point the
      // callback body reads it), even though it is definitely assigned by
      // the time either callback can run. Alias to a const so the handlers
      // reference a known-`Worker` binding instead of asserting past the
      // checker.
      const activeWorker = worker;

      activeWorker.onmessage = (e: MessageEvent) => {
        const { ids, offsets, lengths, lines, types, count, oversizedIds } = e.data;
        const idArr = new Uint32Array(ids);
        const offsetArr = new Uint32Array(offsets);
        const lengthArr = new Uint32Array(lengths);
        const lineArr = new Uint32Array(lines);

        const refs: EntityRefWorkerResult[] = new Array(count);
        for (let i = 0; i < count; i++) {
          refs[i] = {
            expressId: idArr[i],
            type: types[i],
            byteOffset: offsetArr[i],
            byteLength: lengthArr[i],
            lineNumber: lineArr[i],
          };
        }

        activeWorker.terminate();
        resolve({ refs, oversizedIdCount: oversizedIds });
      };

      activeWorker.onerror = (e) => {
        activeWorker.terminate();
        reject(new Error(`Scan worker error: ${e.message}`));
      };

      // Send buffer copy to worker (structured clone — browser copies efficiently).
      // Do NOT transfer: caller needs the original buffer for columnar parsing.
      activeWorker.postMessage(buffer);
    } catch (err) {
      worker?.terminate();
      reject(err);
    }
  });
}
