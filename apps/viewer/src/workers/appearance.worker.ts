/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import init, { IfcAPI } from '@ifc-lite/wasm';
import { decodePagePlan } from '../lib/appearance/page-plan-output.js';
import type { AnnotationPlanePlan, AnnotationPlaneRequest, PageAppearancePlan, PageAppearanceRequest, AppearanceCatalog, AppearanceCatalogRequest, AppearancePlan, AppearanceRequest, AppearanceWorkerRequest, AppearanceWorkerResponse } from '../lib/appearance/planner-types.js';

/** Canonical Rust does graph eligibility, projection and IFC authoring. Exported
 * within the viewer for real-WASM contract tests; production calls only in this
 * worker. One job per worker bounds retained WebAssembly.Memory to that job. */
async function runAppearanceJob<T>(invoke: (api: IfcAPI) => Uint8Array, decode: (bytes: Uint8Array) => T = bytes => JSON.parse(new TextDecoder().decode(bytes)) as T): Promise<T> {
  await init();
  const api = new IfcAPI();
  try { return decode(invoke(api)); }
  finally { api.free(); }
}
export function runAppearancePlanning(source: Uint8Array, request: AppearanceRequest): Promise<AppearancePlan> {
  return runAppearanceJob(api => api.planAppearance(source, JSON.stringify(request)));
}
export function runAppearanceCatalog(source: Uint8Array, request: AppearanceCatalogRequest): Promise<AppearanceCatalog> {
  return runAppearanceJob(api => api.catalogAppearance(source, JSON.stringify(request)));
}

export function runPageAppearancePlanning(source: Uint8Array, request: PageAppearanceRequest, rgba: Uint8Array): Promise<PageAppearancePlan> {
  return runAppearanceJob(api => api.planPageAppearance(source, JSON.stringify(request), rgba), decodePagePlan);
}

export function runAnnotationPlanePlanning(source: Uint8Array, request: AnnotationPlaneRequest): Promise<AnnotationPlanePlan> {
  return runAppearanceJob(api => api.planAnnotationPlane(source, JSON.stringify(request)));
}

const isWorkerScope = typeof self !== 'undefined' &&
  typeof (globalThis as { window?: unknown }).window === 'undefined' &&
  typeof (self as unknown as Worker).postMessage === 'function';
if (isWorkerScope) {
  self.onmessage = async (event: MessageEvent<AppearanceWorkerRequest>) => {
    const job = event.data;
    if (!job || (job.type !== 'plan' && job.type !== 'catalog' && job.type !== 'page-plan' && job.type !== 'annotation-plan')) return;
    try {
      const response: AppearanceWorkerResponse = job.type === 'plan'
        ? { type: 'complete', id: job.id, plan: await runAppearancePlanning(job.source, job.request) }
        : job.type === 'catalog'
          ? { type: 'catalog-complete', id: job.id, catalog: await runAppearanceCatalog(job.source, job.request) }
          : job.type === 'annotation-plan'
            ? { type: 'annotation-complete', id: job.id, result: await runAnnotationPlanePlanning(job.source, job.request) }
            : { type: 'page-complete', id: job.id, result: await runPageAppearancePlanning(job.source, job.request, job.rgba) };
      (self as unknown as Worker).postMessage(response);
    } catch (error) {
      (self as unknown as Worker).postMessage({ type: 'error', id: job.id,
        message: error instanceof Error ? error.message : String(error) } satisfies AppearanceWorkerResponse);
    }
  };
}
