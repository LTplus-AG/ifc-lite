/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parentPort, workerData } from 'node:worker_threads';
import { openModel } from '@ifc-lite/sdk/headless';

const model = await openModel(new Uint8Array(workerData), { disableWorkerScan: true });
try {
  parentPort.postMessage({ started: true });
  // A synchronous operation cannot process an abort message. The owning
  // thread must terminate this actual worker, just as for synchronous parsing.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
} finally { model.close(); }
