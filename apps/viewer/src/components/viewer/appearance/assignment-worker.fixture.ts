/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { IfcAPI } from '@ifc-lite/wasm';
import type { AppearanceWorker } from '@/lib/appearance/planner-worker-client.js';
import type { AppearanceWorkerRequest, AppearanceWorkerResponse, AppearancePlan, AppearanceCatalog } from '@/lib/appearance/planner-types.js';

/** Real WASM solver behind the worker transport. Pausing changes delivery only,
 * so mounted stale/cancel tests never substitute a fabricated native plan. */
export function installAssignmentWorker() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const waiting: Array<() => void> = [];
  let hold = false;
  class NativeWorker implements AppearanceWorker {
    onmessage: ((event: MessageEvent<AppearanceWorkerResponse>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror = null;
    stopped = false;
    terminate() { this.stopped = true; }
    postMessage(job: AppearanceWorkerRequest) {
      const execute = () => queueMicrotask(() => {
        if (this.stopped) return;
        const api = new IfcAPI();
        try {
          let response: AppearanceWorkerResponse;
          if (job.type === 'catalog') response = { type: 'catalog-complete', id: job.id,
            catalog: JSON.parse(new TextDecoder().decode(api.catalogAppearance(new Uint8Array(job.source), JSON.stringify(job.request)))) as AppearanceCatalog };
          else if (job.type === 'plan') response = { type: 'complete', id: job.id,
            plan: JSON.parse(new TextDecoder().decode(api.planAppearance(new Uint8Array(job.source), JSON.stringify(job.request)))) as AppearancePlan };
          else throw new Error('Unexpected assignment fixture request');
          this.onmessage?.({ data: response } as MessageEvent<AppearanceWorkerResponse>);
        } catch (error) { this.onerror?.({ message: String(error) } as ErrorEvent); }
        finally { api.free(); }
      });
      if (hold && job.type === 'plan') waiting.push(execute); else execute();
    }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: NativeWorker });
  return { hold() { hold = true; }, waiting: () => waiting.length,
    release() { hold = false; for (const execute of waiting.splice(0)) execute(); },
    dispose() { waiting.length = 0; if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor); else Reflect.deleteProperty(globalThis, 'Worker'); },
  };
}
