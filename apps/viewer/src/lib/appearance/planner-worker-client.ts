/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AppearanceCatalog, AppearanceCatalogRequest, AppearancePlan, AppearanceRequest, AppearanceWorkerJob, AppearanceWorkerRequest, AppearanceWorkerResponse } from './planner-types.js';

export interface AppearanceWorker {
  onmessage: ((event: MessageEvent<AppearanceWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: AppearanceWorkerRequest): void;
  terminate(): void;
}
export interface AppearancePlanner {
  plan(source: Uint8Array, request: AppearanceRequest, options?: { signal?: AbortSignal }): Promise<AppearancePlan>;
  catalog(source: Uint8Array, request: AppearanceCatalogRequest, options?: { signal?: AbortSignal }): Promise<AppearanceCatalog>;
  cancel(): void;
  dispose(): void;
}
const aborted = () => new DOMException('Appearance planning was cancelled', 'AbortError');

/** New requests supersede old jobs. Cancellation terminates CPU-heavy Rust
 * immediately rather than waiting for the worker event loop to receive it. */
export function createAppearancePlanner(options: {
  workerFactory?: () => AppearanceWorker;
  timeoutMs?: number;
} = {}): AppearancePlanner {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid appearance worker timeout');
  const createWorker = options.workerFactory ?? (() =>
    new Worker(new URL('../../workers/appearance.worker.ts', import.meta.url), { type: 'module' }));
  let cancelActive: (() => void) | undefined;
  let sequence = 0;
  let disposed = false;
  const cancel = () => cancelActive?.();
  const run = <T>(source: Uint8Array, job: AppearanceWorkerJob,
    accept: (message: Exclude<AppearanceWorkerResponse, { type: 'error' }>) => T,
    { signal }: { signal?: AbortSignal } = {}): Promise<T> => {
    cancel();
    if (disposed) return Promise.reject(new Error('Appearance planner is disposed'));
    if (signal?.aborted) return Promise.reject(aborted());
    // Match the Rust source budget before structured clone and WASM upload
    // allocate additional copies of the effective IFC snapshot.
    if (source.byteLength > 128 * 1024 * 1024) {
      return Promise.reject(new Error('Appearance source exceeds 128 MiB. Use a smaller IFC model.'));
    }
    if (job.request.productIds.length > 10_000) {
      return Promise.reject(new Error('Appearance scope exceeds 10000 owners. Choose a smaller scope.'));
    }
    const id = ++sequence;
    return new Promise<T>((resolve, reject) => {
      let worker: AppearanceWorker;
      try { worker = createWorker(); }
      catch (error) { reject(new Error(`Cannot start appearance worker: ${error instanceof Error ? error.message : String(error)}`)); return; }
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error, result?: T) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null;
        worker.terminate();
        if (sequence === id) cancelActive = undefined;
        if (error) reject(error); else resolve(result!);
      };
      const onAbort = () => finish(aborted());
      cancelActive = onAbort;
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(new Error('Appearance planning stopped responding. Try a smaller scope.')), timeoutMs);
      worker.onmessage = event => {
        const message = event.data;
        if (!message || message.id !== id || settled || sequence !== id) return;
        if (message.type === 'error') { finish(new Error(message.message)); return; }
        try { finish(undefined, accept(message)); }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      };
      worker.onerror = event => finish(new Error(event.message || 'Appearance worker crashed'));
      worker.onmessageerror = () => finish(new Error('Appearance worker sent an unreadable message'));
      try {
        // Structured clone copies the source. Never transfer its buffer: the
        // caller may be using that same storage for the live IFC model.
        worker.postMessage({ ...job, id, source });
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      // A custom factory may have triggered abort synchronously during setup.
      if (signal?.aborted) onAbort();
    });
  };
  return {
    cancel,
    dispose() { disposed = true; cancel(); },
    plan(source, request, options) {
      const revision = request.sourceRevision, allocationStart = request.nextExpressId;
      return run(source, { type: 'plan', request }, message => {
        if (message.type !== 'complete' || !message.plan || message.plan.sourceRevision !== revision
          || message.plan.nextExpressId !== allocationStart) throw new Error('Appearance worker returned a stale model revision');
        return message.plan;
      }, options);
    },
    catalog(source, request, options) {
      const revision = request.sourceRevision;
      return run(source, { type: 'catalog', request }, message => {
        if (message.type !== 'catalog-complete' || !message.catalog || message.catalog.sourceRevision !== revision
          || !Array.isArray(message.catalog.products) || !Array.isArray(message.catalog.types)
          || !Array.isArray(message.catalog.missingProductIds)) throw new Error('Appearance worker returned a stale or invalid catalog');
        return message.catalog;
      }, options);
    },
  };
}
