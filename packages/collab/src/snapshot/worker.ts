/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Worker-safe snapshot helpers (spec §16.1 deferred from v0.1).
 *
 * `snapshotToIfcx` and `seedFromIfcx` are pure functions that operate
 * on a Y.Doc — they do not touch the DOM and are therefore safe to
 * call from a Web Worker. This module re-exports them along with a
 * tiny `runSnapshotWorker(self)` adapter that consumers can drop into
 * a worker entry point to get a postMessage-driven snapshot service
 * without writing the boilerplate.
 *
 * Wire from app code:
 *   - in `worker.ts`: `import { runSnapshotWorker } from '@ifc-lite/collab/snapshot/worker'; runSnapshotWorker(self);`
 *   - in main thread: post `{ kind: 'snapshot', updates }` and await
 *     a `{ kind: 'snapshot:ok', ifcx }` reply.
 */

import * as Y from 'yjs';
import { createCollabDoc } from '../doc/schema.js';
import { snapshotToIfcx, type SnapshotOptions } from './to-ifcx.js';
import { seedFromIfcx, parseIfcxInput, type IfcxInput } from './from-ifcx.js';

export type WorkerRequest =
  | {
      kind: 'snapshot';
      /** Encoded Y state (e.g. `Y.encodeStateAsUpdate(doc)`) to snapshot. */
      update: Uint8Array;
      options?: SnapshotOptions;
      requestId?: string;
    }
  | {
      kind: 'seed';
      /** IFCX text or already-decoded `IfcxFile`. */
      source: IfcxInput;
      requestId?: string;
    };

export type WorkerResponse =
  | {
      kind: 'snapshot:ok';
      requestId?: string;
      ifcx: ReturnType<typeof snapshotToIfcx>;
    }
  | {
      kind: 'seed:ok';
      requestId?: string;
      /** Y update encoded from the seeded doc, ready for `applyUpdate` on the main thread. */
      update: Uint8Array;
    }
  | {
      kind: 'error';
      requestId?: string;
      message: string;
    };

/** Minimal subset of `Worker`'s self / DedicatedWorkerGlobalScope. */
export interface WorkerScopeLike {
  addEventListener(
    type: 'message',
    listener: (event: { data: WorkerRequest }) => void,
  ): void;
  postMessage(data: WorkerResponse, transfer?: Transferable[]): void;
}

/**
 * Mount a `(snapshot|seed)` request handler on a worker scope.
 *
 * The handler creates a fresh Y.Doc per request, applies the supplied
 * update (snapshot path) or seeds from IFCX (seed path), then posts the
 * result back. Memory is bounded to the lifetime of one request.
 */
export function runSnapshotWorker(scope: WorkerScopeLike): void {
  scope.addEventListener('message', (event) => {
    const msg = event.data;
    try {
      switch (msg.kind) {
        case 'snapshot': {
          const doc = createCollabDoc({ gc: false });
          if (msg.update.byteLength > 0) Y.applyUpdate(doc, msg.update);
          const ifcx = snapshotToIfcx(doc, msg.options);
          scope.postMessage({ kind: 'snapshot:ok', requestId: msg.requestId, ifcx });
          return;
        }
        case 'seed': {
          const doc = createCollabDoc({ gc: false });
          // Decode whatever shape the caller hands us.
          parseIfcxInput(msg.source);
          seedFromIfcx(doc, msg.source);
          const update = Y.encodeStateAsUpdate(doc);
          scope.postMessage(
            { kind: 'seed:ok', requestId: msg.requestId, update },
            // Transfer the buffer so we don't double-copy it.
            [update.buffer],
          );
          return;
        }
        default: {
          const exhaustive: never = msg;
          throw new Error(`@ifc-lite/collab: unknown worker message kind: ${(exhaustive as { kind?: string }).kind}`);
        }
      }
    } catch (err) {
      scope.postMessage({
        kind: 'error',
        requestId: (msg as { requestId?: string }).requestId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

// Re-export the pure helpers so consumers that don't want the
// postMessage adapter can still import the worker-safe surface from
// one entry point.
export { snapshotToIfcx, seedFromIfcx };
