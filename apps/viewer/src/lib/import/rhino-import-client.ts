/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main-thread client for `workers/rhinoImport.worker.ts`: one worker per load,
 * terminated the moment the run settles or is aborted. `rhino-import-job.ts`
 * holds why it works that way; aborting terminates the worker because that is
 * the only way to stop synchronous wasm mid-run.
 *
 * The promise machinery below is the same shape as
 * `export/rhino-export-client.ts`. Folding the two into one
 * `oneShotWorkerRun` helper is worth doing and is deliberately not done here:
 * it would rewrite the shipped export client inside a PR about import.
 */

import type { RhinoImport } from '@ifc-lite/rhino3dm';
import type { RhinoImportErrorCode, RhinoImportWorkerRequest, RhinoImportWorkerResponse } from './rhino-import-job';

/** A failed read, carrying the reader's code so the caller can word the refusal. */
export class RhinoImportError extends Error {
  readonly code: RhinoImportErrorCode;
  constructor(code: RhinoImportErrorCode, message: string) {
    super(message);
    this.name = 'RhinoImportError';
    this.code = code;
  }
}

/**
 * The reader's own size ceiling, `MAX_3DM_BYTES`
 * (`packages/rhino3dm/src/read/read.ts`, spec "Size ceiling", decision D7).
 *
 * Mirrored rather than imported, which is not a preference: the main thread
 * may import that package's TYPES but never its values, because a static
 * value edge pulls the 2.67 MB rhino3dm wasm into the startup graph and
 * `apps/viewer/scripts/check-rhino3dm-lazy.mjs` fails the build over it. The
 * constant is not on the package's public surface either. Single-sourcing it
 * is TODO(remove-by: #10037 exports it and a test pins this against it, viewer).
 */
export const MAX_3DM_IMPORT_BYTES = 400 * 1024 * 1024;

/**
 * Not `formatBytes` from `@/lib/utils`, which is otherwise identical in the MB
 * band: it switches to GB at 1 GiB, so a 1.5 GB archive would be refused as
 * "1.5 GB" here and "1536 MB" by the reader. The point of this function is to
 * say exactly what the reader says, so which side caught the file does not
 * change the sentence.
 */
const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * Refuse an archive above the ceiling, or `null` to go on.
 *
 * The caller asks BEFORE it copies the source buffer. Left to the worker, a
 * file over the cap is held twice (the load's buffer plus the copy the
 * request transfers) for a read that was always going to be refused, and the
 * allocation that fails on the way there is reported as `worker-failed`
 * rather than the size-ceiling message the user can act on. Same code and
 * same wording as the reader's own refusal.
 *
 * One thing the two do NOT share is the ORDER. `readRhino3dm` reads the
 * archive version first, so it answers `newer-archive` for an oversized file
 * from a Rhino it does not know; this answers `too-large`. Both refusals are
 * true and both are actionable, and the alternative is mirroring the header
 * parser here as well, so the ordering difference is accepted rather than
 * closed. It is not reachable for a non-`.3dm` at all: `detectFormat` routes
 * this path on the 24-byte Rhino magic, so `not-3dm` cannot be the answer by
 * the time anything gets here.
 */
export function rhino3dmSizeRefusal(byteLength: number): RhinoImportError | null {
  if (byteLength <= MAX_3DM_IMPORT_BYTES) return null;
  return new RhinoImportError(
    'too-large',
    `This file is ${megabytes(byteLength)}; the reader handles up to ${megabytes(MAX_3DM_IMPORT_BYTES)}. Split the model into smaller files in Rhino.`,
  );
}

/** Objects read so far, as the reader counts them. */
export interface RhinoImportProgress { done: number; total: number }

/** What the client needs from a worker; a test supplies an in-process one. */
export interface RhinoImportWorkerLike {
  onmessage: ((event: MessageEvent<RhinoImportWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: RhinoImportWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

/**
 * Longest silence allowed between worker messages; each progress message
 * restarts it. Generous because the reader posts nothing while it extracts
 * buffers and bakes blocks (seconds on a 400 MB archive); reaching it means
 * the worker is gone, not slow — an OS-killed worker fires neither `message`
 * nor `error`.
 */
const RHINO_IMPORT_TIMEOUT_MS = 10 * 60_000;

const createDefaultWorker = (): RhinoImportWorkerLike =>
  new Worker(new URL('../../workers/rhinoImport.worker.ts', import.meta.url), { type: 'module' }) as RhinoImportWorkerLike;

let createWorker: () => RhinoImportWorkerLike = createDefaultWorker;

/** Tests only. Pass null to restore the real worker. */
export function __setRhinoImportWorkerFactoryForTest(factory: (() => RhinoImportWorkerLike) | null): void {
  createWorker = factory ?? createDefaultWorker;
}

let nextId = 1;

/**
 * Read one `.3dm` in a worker. `bytes` is transferred, so it must be a fresh
 * read of the file rather than a view the loaded model will read from.
 */
export function readRhino3dmInWorker(
  bytes: Uint8Array,
  onProgress?: (progress: RhinoImportProgress) => void,
  signal?: AbortSignal,
): Promise<RhinoImport> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Rhino import cancelled', 'AbortError'));
      return;
    }
    let worker: RhinoImportWorkerLike;
    try {
      worker = createWorker();
    } catch (error) {
      reject(new RhinoImportError('worker-failed', `Failed to start the Rhino import worker: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    const id = nextId++;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => settle(() => reject(new DOMException('Rhino import cancelled', 'AbortError')));
    function settle(fn: () => void): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      fn();
    }
    function armTimer(): void {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(
        () => settle(() => reject(new RhinoImportError('worker-failed', 'The Rhino import worker stopped responding'))),
        RHINO_IMPORT_TIMEOUT_MS,
      );
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    armTimer();

    worker.onmessage = (event) => {
      const message = event.data;
      if (!message || (message.id !== id && !(message.type === 'error' && message.id === 0))) return;
      switch (message.type) {
        case 'progress':
          armTimer();
          onProgress?.({ done: message.done, total: message.total });
          return;
        case 'complete':
          settle(() => resolve(message.result));
          return;
        case 'error':
          settle(() => reject(new RhinoImportError(message.code, message.message)));
      }
    };
    worker.onerror = (event) => settle(() => reject(new RhinoImportError('worker-failed', event.message || 'The Rhino import worker crashed')));
    worker.onmessageerror = () => settle(() => reject(new RhinoImportError('worker-failed', 'The Rhino import worker sent an unreadable message')));

    try {
      worker.postMessage({ type: 'import', id, bytes }, [bytes.buffer as ArrayBuffer]);
    } catch (error) {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });
}
