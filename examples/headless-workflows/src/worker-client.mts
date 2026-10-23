/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Worker } from 'node:worker_threads';
import type { WorkerResult } from './messages.mjs';

export async function queryDoors(bytes: Uint8Array, signal: AbortSignal, active: (delta: number) => void, createWorker?: (input: ArrayBuffer) => Worker): Promise<WorkerResult> {
  signal.throwIfAborted();
  // Transfer an exact owned allocation; pooled Node Buffers can contain other bytes.
  const input = Uint8Array.from(bytes).buffer;
  const worker = createWorker ? createWorker(input) : new Worker(new URL('./worker.mjs', import.meta.url), { workerData: input, transferList: [input] });
  active(1);
  let abort: () => void = () => undefined;
  try {
    return await new Promise<WorkerResult>((resolve, reject) => {
      abort = () => reject(signal.reason);
      worker.on('message', (message: unknown) => {
        if (message && typeof message === 'object' && 'ok' in message && typeof message.ok === 'boolean')
          resolve(message as WorkerResult);
      });
      worker.once('error', reject);
      worker.once('exit', code => reject(new Error(`Worker exited before a result (${code})`)));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  } finally {
    signal.removeEventListener('abort', abort);
    await worker.terminate();
    active(-1);
  }
}
