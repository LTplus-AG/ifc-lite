/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test-only stand-in for `workers/rhinoExport.worker.ts`: runs the REAL job
 * (`runRhinoExportJob`) in-process with test engines, and passes every message
 * through `structuredClone` with async delivery, as a worker hop would.
 * Records the requests it received and whether it was terminated.
 */

import {
  runRhinoExportJob,
  type RhinoExportJobDeps,
  type RhinoExportWorkerRequest,
  type RhinoExportWorkerResponse,
} from '@/lib/export/rhino-export-job';
import { __setRhinoExportWorkerFactoryForTest, type RhinoExportWorkerLike } from '@/lib/export/rhino-export-client';

export interface FakeRhinoWorkerHandle {
  requests: RhinoExportWorkerRequest[];
  terminated: () => number;
  spawned: () => number;
  restore(): void;
}

export function installFakeRhinoWorker(deps: RhinoExportJobDeps): FakeRhinoWorkerHandle {
  const requests: RhinoExportWorkerRequest[] = [];
  let terminated = 0;
  let spawned = 0;

  class FakeWorker implements RhinoExportWorkerLike {
    onmessage: RhinoExportWorkerLike['onmessage'] = null;
    onerror: RhinoExportWorkerLike['onerror'] = null;
    onmessageerror: RhinoExportWorkerLike['onmessageerror'] = null;
    private dead = false;

    postMessage(message: RhinoExportWorkerRequest): void {
      const request = structuredClone(message);
      requests.push(request);
      void runRhinoExportJob(request, (reply: RhinoExportWorkerResponse) => {
        const data = structuredClone(reply);
        setTimeout(() => {
          if (!this.dead) this.onmessage?.({ data } as MessageEvent<RhinoExportWorkerResponse>);
        }, 0);
      }, deps);
    }

    terminate(): void {
      this.dead = true;
      terminated++;
    }
  }

  __setRhinoExportWorkerFactoryForTest(() => {
    spawned++;
    return new FakeWorker();
  });
  return {
    requests,
    terminated: () => terminated,
    spawned: () => spawned,
    restore: () => __setRhinoExportWorkerFactoryForTest(null),
  };
}
