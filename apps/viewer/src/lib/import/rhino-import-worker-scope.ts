/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { runRhinoImportJob, type RhinoImportJobDeps, type RhinoImportWorkerRequest } from './rhino-import-job';

/** A decode failure has no readable request id. Zero is reserved for worker-wide errors. */
export function installRhinoImportWorker(scope: Pick<Worker, 'onmessage' | 'onmessageerror' | 'postMessage'>, deps: RhinoImportJobDeps): void {
  scope.onmessageerror = () => {
    scope.postMessage({ type: 'error', id: 0, code: 'worker-failed', message: 'The Rhino import worker received an unreadable message' });
  };
  scope.onmessage = (event: MessageEvent<RhinoImportWorkerRequest>) => {
    if (event.data?.type !== 'import') return;
    void runRhinoImportJob(event.data, (message, transfer) => scope.postMessage(message, transfer ?? []), deps);
  };
}
