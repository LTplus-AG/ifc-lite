/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test-only stand-in for `workers/rhinoImport.worker.ts`: runs the REAL job
 * (`runRhinoImportJob`) in-process with a test reader, and passes every
 * message through `structuredClone` with async delivery, as a worker hop
 * would. Records the requests it received and whether it was terminated.
 */

import {
  runRhinoImportJob,
  type RhinoImportJobDeps,
  type RhinoImportWorkerRequest,
  type RhinoImportWorkerResponse,
} from '@/lib/import/rhino-import-job';
import { __setRhinoImportWorkerFactoryForTest, type RhinoImportWorkerLike } from '@/lib/import/rhino-import-client';

export interface FakeRhinoImportWorkerHandle {
  requests: RhinoImportWorkerRequest[];
  terminated: () => number;
  spawned: () => number;
  restore(): void;
}

export function installFakeRhinoImportWorker(deps: RhinoImportJobDeps): FakeRhinoImportWorkerHandle {
  const requests: RhinoImportWorkerRequest[] = [];
  let terminated = 0;
  let spawned = 0;

  class FakeWorker implements RhinoImportWorkerLike {
    onmessage: RhinoImportWorkerLike['onmessage'] = null;
    onerror: RhinoImportWorkerLike['onerror'] = null;
    onmessageerror: RhinoImportWorkerLike['onmessageerror'] = null;
    private dead = false;

    postMessage(message: RhinoImportWorkerRequest, transfer?: Transferable[]): void {
      // The real request transfers its bytes, so clone before the caller's
      // view is detached, exactly as structured clone would.
      const request = structuredClone(message, transfer ? { transfer } : undefined);
      requests.push(request);
      void runRhinoImportJob(request, (reply: RhinoImportWorkerResponse, replyTransfer) => {
        const data = structuredClone(reply, replyTransfer ? { transfer: replyTransfer } : undefined);
        setTimeout(() => {
          if (!this.dead) this.onmessage?.({ data } as MessageEvent<RhinoImportWorkerResponse>);
        }, 0);
      }, deps);
    }

    terminate(): void {
      this.dead = true;
      terminated++;
    }
  }

  __setRhinoImportWorkerFactoryForTest(() => {
    spawned++;
    return new FakeWorker();
  });
  return {
    requests,
    terminated: () => terminated,
    spawned: () => spawned,
    restore: () => __setRhinoImportWorkerFactoryForTest(null),
  };
}
