/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parentPort, workerData } from 'node:worker_threads';
import { withModelBytes, doorRows } from './common.mjs';
import type { WorkerResult } from './messages.mjs';

if (!parentPort) throw new Error('This entry point runs only in a Worker');
const input: unknown = workerData;
try {
  if (!(input instanceof ArrayBuffer)) throw new TypeError('Worker input must be an ArrayBuffer');
  const doors = await withModelBytes(new Uint8Array(input), doorRows, { modelName: 'upload.ifc' });
  parentPort.postMessage({ ok: true, doors } satisfies WorkerResult);
} catch (error) {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'PROCESSING_FAILED';
  parentPort.postMessage({ ok: false, code, message: error instanceof Error ? error.message : String(error) } satisfies WorkerResult);
}
