/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main-thread client for {@link ../../workers/zoneSplit.worker.ts}. See that
 * file for why the cutting must not run on the main thread.
 *
 * One worker per run, terminated the moment the run settles. The same trade
 * `idsWorkerClient` makes and for the same reason: a geometry export is a rare,
 * explicit click, and a resident worker would pin a second `WebAssembly.Memory`
 * (which never shrinks) for the whole session to save one compile.
 */

import type {
  ZoneSplitJob,
  ZoneSplitOutcome,
  ZoneSplitWorkerRequest,
  ZoneSplitWorkerResponse,
} from '@/workers/zoneSplit.worker.js';
import type { Zone } from './types.js';

export type { ZoneSplitJob, ZoneSplitOutcome };

/** Reported as the batch advances, so a long run can say where it is. */
export type ZoneSplitProgress = (done: number, total: number) => void;

/** The one call the export makes to get its elements cut, whichever thread
 *  does it. The in-process path implements the same signature. */
export type ZoneSplitBatchFn = (
  request: { zones: readonly Zone[]; zoneIndex: number; jobs: ZoneSplitJob[]; tolerance?: number },
  onProgress?: ZoneSplitProgress,
) => Promise<ZoneSplitOutcome[]>;

export function zoneSplitWorkerSupported(): boolean {
  return typeof Worker !== 'undefined';
}

/**
 * Ceiling on one batch.
 *
 * Deliberately generous: the work itself is ~357 ms per element and a whole
 * building's straddlers can run into minutes, so anything near this means the
 * worker is GONE rather than slow. It exists because a worker killed by the OS
 * (renderer OOM, the likely failure for a huge model) fires neither `message`
 * nor `error`, and without a deadline the export would never settle and the
 * panel's button would stay disabled for the rest of the session.
 */
export const ZONE_SPLIT_TIMEOUT_MS = 600_000;

export const splitZonesInWorker: ZoneSplitBatchFn = (request, onProgress) =>
  new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../../workers/zoneSplit.worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      reject(new Error(`Failed to spawn the zone split worker: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    const id = 1;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (fn: () => void) => {
      if (timer !== null) clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      fn();
    };
    timer = setTimeout(
      () => settle(() => reject(new Error('The zone split worker stopped responding'))),
      ZONE_SPLIT_TIMEOUT_MS,
    );

    worker.onmessage = (event: MessageEvent<ZoneSplitWorkerResponse>) => {
      const message = event.data;
      if (!message || message.id !== id) return;
      switch (message.type) {
        case 'progress':
          onProgress?.(message.done, message.total);
          return;
        case 'complete':
          settle(() => resolve(message.outcomes));
          return;
        case 'error':
          settle(() => reject(new Error(message.message)));
      }
    };
    worker.onerror = (event) => settle(() => reject(new Error(event.message || 'the zone split worker crashed')));
    worker.onmessageerror = () => settle(() => reject(new Error('the zone split worker sent an unreadable message')));

    const payload: ZoneSplitWorkerRequest = {
      type: 'split',
      id,
      zones: request.zones as Zone[],
      zoneIndex: request.zoneIndex,
      jobs: request.jobs,
      tolerance: request.tolerance,
    };
    // No transfer list, on purpose: the positions and indices belong to the
    // renderer's live scene, and transferring them would detach the buffers the
    // model is drawn from. The clone's copy IS the price of not blanking the
    // viewport.
    worker.postMessage(payload);
  });
