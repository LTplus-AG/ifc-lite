/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scan-to-BIM detection worker (#6894). Segmenting a 2 M point scan sample
 * takes about 3 s of synchronous wasm; here it runs off the main thread. The
 * client cancels a run by terminating this worker, the only way to stop a
 * synchronous wasm call, so each request carries the whole job.
 */

import { ensureWasm } from '@/lib/wasm/ensure-wasm';
import { runScanDetectJob, type ScanDetectJob, type ScanDetectResult, type ScanDetectStage } from '@/lib/scan-to-bim/detect-job';

export interface ScanDetectWorkerRequest {
  type: 'detect';
  id: number;
  job: ScanDetectJob;
}

export type ScanDetectWorkerResponse =
  | { type: 'progress'; id: number; stage: ScanDetectStage }
  | { type: 'complete'; id: number; result: ScanDetectResult }
  | { type: 'error'; id: number; message: string };

const post = (message: ScanDetectWorkerResponse) => self.postMessage(message);

self.onmessage = async (event: MessageEvent<ScanDetectWorkerRequest>) => {
  const request = event.data;
  if (request?.type !== 'detect') return;
  try {
    await ensureWasm();
    const result = runScanDetectJob(request.job, (stage) => post({ type: 'progress', id: request.id, stage }));
    post({ type: 'complete', id: request.id, result });
  } catch (error) {
    post({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
};
