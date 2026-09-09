import type { ScanRegistrationRequest, ScanRegistrationReport } from './scan/types';
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { CapturedMeshPlan, CapturedMeshRequest, AnnotationPlanePlan, AnnotationPlaneRequest, PageAppearancePlan, PageAppearanceRequest, AppearanceCatalog, AppearanceCatalogRequest, AppearancePlan, AppearanceRequest, AppearanceWorkerJob, AppearanceWorkerRequest, AppearanceWorkerResponse } from './planner-types.js';

export interface AppearanceWorker {
  onmessage: ((event: MessageEvent<AppearanceWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: AppearanceWorkerRequest): void;
  terminate(): void;
}
export interface AppearancePlanner {
  registerScan(request: ScanRegistrationRequest, options?: { signal?: AbortSignal }): Promise<ScanRegistrationReport>;
  capturedMeshPlan(source: Uint8Array, request: CapturedMeshRequest, options?: { signal?: AbortSignal }): Promise<CapturedMeshPlan>;
  annotationPlan(source: Uint8Array, request: AnnotationPlaneRequest, options?: { signal?: AbortSignal }): Promise<AnnotationPlanePlan>;
  plan(source: Uint8Array, request: AppearanceRequest, options?: { signal?: AbortSignal }): Promise<AppearancePlan>;
  pagePlan(source: Uint8Array, request: PageAppearanceRequest, rgba: Uint8Array, options?: { signal?: AbortSignal }): Promise<PageAppearancePlan>;
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
    const request = job.type === 'page-plan' ? job.request.appearance : job.request;
    if (job.type === 'page-plan' && job.rgba.byteLength > 128 * 1024 * 1024) {
      return Promise.reject(new Error('Page raster payload exceeds 128 MiB. Use a smaller source.'));
    }
    // Refuse oversized capture arrays before structured clone and JSON encoding
    // allocate copies; semantic geometry validation remains canonical Rust.
    if (job.type === 'captured-mesh-plan') {
      const mesh = job.request.mesh;
      if ([mesh.positions.length, mesh.triangles.length, mesh.uvs.length].some(n => n === 0 || n > 200_000)
        || mesh.uvTriangles.length !== mesh.triangles.length) {
        return Promise.reject(new Error('Captured mesh needs 1..200000 position, triangle and UV rows, with one UV triangle per face'));
      }
    }
    if ('productIds' in request && request.productIds.length > 10_000) {
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
    registerScan(request, options) {
      if (request.fit.length > 256 || request.heldOut.length > 256 || new TextEncoder().encode(JSON.stringify(request)).byteLength > 512 * 1024) return Promise.reject(new Error('Scan registration exceeds its request budget'));
      const frozen = structuredClone(request);
      return run(new Uint8Array(), { type: 'scan-registration', request: frozen }, message => {
        if (message.type !== 'scan-registration-complete' || !message.result
          || JSON.stringify(message.result.sourceFrame) !== JSON.stringify(frozen.sourceFrame)
          || JSON.stringify(message.result.targetFrame) !== JSON.stringify(frozen.targetFrame)
          || message.result.algorithm !== 'ifclite-rigid-correspondence-v1') throw new Error('Scan worker returned a stale registration');
        return message.result;
      }, options);
    },
    plan(source, request, options) {
      const revision = request.sourceRevision, allocationStart = request.nextExpressId;
      return run(source, { type: 'plan', request }, message => {
        if (message.type !== 'complete' || !message.plan || message.plan.sourceRevision !== revision
          || message.plan.nextExpressId !== allocationStart) throw new Error('Appearance worker returned a stale model revision');
        return message.plan;
      }, options);
    },
    capturedMeshPlan(source, request, options) {
      const revision = request.sourceRevision, allocationStart = request.nextExpressId;
      return run(source, { type: 'captured-mesh-plan', request }, message => {
        if (message.type !== 'captured-mesh-complete' || !message.result
          || message.result.plan?.sourceRevision !== revision || message.result.plan.nextExpressId !== allocationStart
          || message.result.coordinateSpace !== 'ifc-z-up'
          || message.result.mesh?.express_id !== message.result.objectId
          || message.result.mesh.geometry_item_id !== message.result.geometryItemId
          || message.result.mesh.texture?.url !== request.imageUri) {
          throw new Error('Appearance worker returned a stale or invalid captured mesh plan');
        }
        return message.result;
      }, options);
    },
    annotationPlan(source, request, options) {
      const revision = request.sourceRevision, allocationStart = request.nextExpressId;
      return run(source, { type: 'annotation-plan', request }, message => {
        if (message.type !== 'annotation-complete' || !message.result
          || message.result.plan?.sourceRevision !== revision || message.result.plan.nextExpressId !== allocationStart
          || message.result.coordinateSpace !== 'ifc-z-up'
          || message.result.mesh?.express_id !== message.result.annotationId
          || message.result.mesh.geometry_item_id !== message.result.geometryItemId
          || message.result.mesh.texture?.url !== request.imageUri) {
          throw new Error('Appearance worker returned a stale or invalid annotation plan');
        }
        return message.result;
      }, options);
    },
    pagePlan(source, request, rgba, options) {
      const revision = request.appearance.sourceRevision, allocationStart = request.appearance.nextExpressId;
      return run(source, { type: 'page-plan', request, rgba }, message => {
        if (message.type !== 'page-complete' || !message.result
          || message.result.plan?.sourceRevision !== revision || message.result.plan.nextExpressId !== allocationStart
          || !Array.isArray(message.result.assets) || !Array.isArray(message.result.itemImages)) {
          throw new Error('Appearance worker returned a stale or invalid page plan');
        }
        return message.result;
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
