/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { runRhinoExportJob, type RhinoExportJobDeps, type RhinoExportWorkerRequest } from './rhino-export-job';

/** A decode failure has no readable request id. Zero is reserved for worker-wide errors. */
export function installRhinoExportWorker(scope: Pick<Worker, 'onmessage' | 'onmessageerror' | 'postMessage'>, deps: RhinoExportJobDeps): void {
  scope.onmessageerror = () => {
    scope.postMessage({ type: 'error', id: 0, message: 'The Rhino export worker received an unreadable message' });
  };
  scope.onmessage = (event: MessageEvent<RhinoExportWorkerRequest>) => {
    if (event.data?.type !== 'export') return;
    void runRhinoExportJob(event.data, (message, transfer) => scope.postMessage(message, transfer ?? []), deps);
  };
}
