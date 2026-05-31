/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getGeometryStreamWatchdogMs } from '@ifc-lite/geometry';
import { boundedIteratorReturn } from './streamCleanup.js';

export interface WatchedGeometryStreamOptions {
  /** File name, for the stall error message. */
  fileName: string;
  /** File size in MB, feeds the size-aware watchdog deadline. */
  fileSizeMB: number;
  /** Abort the stream cooperatively (e.g. user cancelled the load). */
  shouldAbort?: () => boolean;
  /** Current batch index — feeds the size-aware watchdog deadline. */
  getBatchCount: () => number;
  /** Meshes rendered so far, for the stall error message. */
  getLastTotalMeshes: () => number;
  /** Override the abandon-cleanup deadline (mostly for tests). */
  cleanupMs?: number;
}

/**
 * Drive a geometry stream under a size-aware watchdog, re-yielding every event.
 *
 * The parallel pipeline only ends once EVERY spawned geometry worker reports
 * `complete`; if the browser fails to instantiate a worker (the "Attempting to
 * create a Worker from an empty source" warning) that worker never reports
 * `ready`/`complete` and never fires `onerror`, so the underlying generator can
 * wedge forever, stranding the load on "Processing geometry (N meshes)". Racing
 * each `next()` against a deadline converts that silent wedge into a thrown,
 * recoverable error. On ANY exit — normal completion, abort, consumer `break`,
 * or a watchdog throw — the `finally` bounds the underlying iterator's shutdown
 * so cleanup (the generator's own `finally`: freeing WASM handles, tearing down
 * workers) runs without re-blocking on the very stall the watchdog just escaped.
 *
 * Generic over the event type so the consumer keeps full type-narrowing in its
 * own `switch`.
 */
export async function* watchedGeometryStream<T>(
  source: AsyncIterable<T>,
  options: WatchedGeometryStreamOptions,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      const watchdogMs = getGeometryStreamWatchdogMs({
        desktopStableWasm: false,
        batchCount: options.getBatchCount(),
        fileSizeMB: options.fileSizeMB,
      });
      let watchdogId: ReturnType<typeof setTimeout> | null = null;
      let result: IteratorResult<T>;
      try {
        result = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => {
            watchdogId = setTimeout(() => {
              reject(new Error(
                `Geometry stream stalled after ${watchdogMs}ms while loading ${options.fileName}. `
                + `Last rendered meshes: ${options.getLastTotalMeshes()}. A geometry worker likely failed to start.`,
              ));
            }, watchdogMs);
          }),
        ]);
      } finally {
        if (watchdogId !== null) clearTimeout(watchdogId);
      }
      if (result.done) return;
      if (options.shouldAbort?.()) return;
      yield result.value;
    }
  } finally {
    await boundedIteratorReturn(iterator, options.cleanupMs);
  }
}
