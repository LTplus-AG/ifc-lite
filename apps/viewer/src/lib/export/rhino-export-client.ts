/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main-thread client for `workers/rhinoExport.worker.ts`.
 *
 * One worker per export, terminated the moment the run settles or is
 * aborted (the same trade `zones/split-worker-client.ts` makes: an export is a
 * rare click, and a resident worker would pin two wasm heaps for the session).
 * Aborting terminates the worker, which is the only way to stop synchronous
 * wasm mid-run.
 *
 * There is deliberately no main-thread fallback: the spec requires the write
 * off the main thread, and a fallback would freeze the viewport on exactly the
 * large models where the worker matters.
 */

import type { Rhino3dmVersion } from '@ifc-lite/rhino3dm';
import type { RhinoSceneExportOptions } from '@ifc-lite/geometry';
import type { RhinoExportWorkerRequest, RhinoExportWorkerResponse } from './rhino-export-job';

export type RhinoExportProgress =
  | { phase: 'scene' }
  | { phase: 'objects'; done: number; total: number }
  | { phase: 'serialize' };

export interface RhinoExportResult {
  bytes: Uint8Array;
  warnings: string[];
}

/** What the client needs from a worker; a test supplies an in-process one. */
export interface RhinoExportWorkerLike {
  onmessage: ((event: MessageEvent<RhinoExportWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: RhinoExportWorkerRequest): void;
  terminate(): void;
}

/**
 * Ceiling on one export. Generous because the measured serialize rate is
 * about 10 MB/s and a large model writes hundreds of MB; reaching it means the
 * worker is gone (an OS-killed worker fires neither `message` nor `error`),
 * not slow.
 */
export const RHINO_EXPORT_TIMEOUT_MS = 30 * 60_000;

const createDefaultWorker = (): RhinoExportWorkerLike =>
  new Worker(new URL('../../workers/rhinoExport.worker.ts', import.meta.url), { type: 'module' }) as RhinoExportWorkerLike;

let createWorker: () => RhinoExportWorkerLike = createDefaultWorker;

/** Tests only. Pass null to restore the real worker. */
export function __setRhinoExportWorkerFactoryForTest(factory: (() => RhinoExportWorkerLike) | null): void {
  createWorker = factory ?? createDefaultWorker;
}

let nextId = 1;

export function exportRhino3dmInWorker(
  request: { content: Uint8Array; options: RhinoSceneExportOptions; version: Rhino3dmVersion },
  onProgress?: (progress: RhinoExportProgress) => void,
  signal?: AbortSignal,
): Promise<RhinoExportResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Rhino export cancelled', 'AbortError'));
      return;
    }
    let worker: RhinoExportWorkerLike;
    try {
      worker = createWorker();
    } catch (error) {
      reject(new Error(`Failed to start the Rhino export worker: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    const id = nextId++;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => settle(() => reject(new DOMException('Rhino export cancelled', 'AbortError')));
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
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(
      () => settle(() => reject(new Error('The Rhino export worker stopped responding'))),
      RHINO_EXPORT_TIMEOUT_MS,
    );

    worker.onmessage = (event) => {
      const message = event.data;
      if (!message || (message.id !== id && !(message.type === 'error' && message.id === 0))) return;
      switch (message.type) {
        case 'phase':
          onProgress?.({ phase: message.phase });
          return;
        case 'progress':
          onProgress?.({ phase: 'objects', done: message.done, total: message.total });
          return;
        case 'complete':
          settle(() => resolve({ bytes: message.bytes, warnings: message.warnings }));
          return;
        case 'error':
          // Keep the engine's message verbatim: callers match NO_RENDER_GEOMETRY on it.
          settle(() => reject(new Error(message.message)));
      }
    };
    worker.onerror = (event) => settle(() => reject(new Error(event.message || 'The Rhino export worker crashed')));
    worker.onmessageerror = () => settle(() => reject(new Error('The Rhino export worker sent an unreadable message')));

    // No transfer list: `content` can be the parsed store's own source view,
    // and transferring it would detach the bytes the loaded model reads from.
    try {
      worker.postMessage({ type: 'export', id, ...request });
    } catch (error) {
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
    }
  });
}
