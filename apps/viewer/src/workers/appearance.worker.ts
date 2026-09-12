/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PdfFillAnnotationRequest, PdfFillAnnotationPlan } from '../lib/appearance/pdf/fill-plan-types';
import type { PdfVectorPage, PreparedPdfVectorPage } from '../lib/appearance/pdf/vector-types';
import type { ScanRegistrationRequest, ScanRegistrationReport } from '../lib/appearance/scan/types';

import type { MeshTransferRequest, MeshTransferPlan } from '../lib/appearance/scan/transfer-types';
import init, { IfcAPI } from '@ifc-lite/wasm';
import { decodePagePlan, decodeAtlasOutput } from '../lib/appearance/page-plan-output.js';
import type { CapturedMeshPlan, CapturedMeshRequest, AnnotationPlanePlan, AnnotationPlaneRequest, PageAppearancePlan, PageAppearanceRequest, AppearanceCatalog, AppearanceCatalogRequest, AppearancePlan, AppearanceRequest, AppearanceWorkerRequest, AppearanceWorkerResponse } from '../lib/appearance/planner-types.js';

/** Canonical Rust does graph eligibility, projection and IFC authoring. Exported
 * within the viewer for real-WASM contract tests; production calls only in this
 * worker. One job per worker bounds retained WebAssembly.Memory to that job. */
async function runAppearanceJob<T>(invoke: (api: IfcAPI) => Uint8Array, decode: (bytes: Uint8Array) => T = bytes => JSON.parse(new TextDecoder().decode(bytes)) as T): Promise<T> {
  await init();
  const api = new IfcAPI();
  try { return decode(invoke(api)); }
  finally { api.free(); }
}
export function runPdfFidelity(page: PdfVectorPage): Promise<PreparedPdfVectorPage> {
  return runAppearanceJob(api => api.preparePdfVectorPage(JSON.stringify(page)));
}
export function runPdfFillAnnotationPlanning(source: Uint8Array, request: PdfFillAnnotationRequest): Promise<PdfFillAnnotationPlan> {
  return runAppearanceJob(api => api.planPdfFillAnnotation(source, JSON.stringify(request)));
}
export function runMeshTransfer(source: Uint8Array, request: MeshTransferRequest, rgba: Uint8Array): Promise<MeshTransferPlan> {
  return runAppearanceJob(api => api.planMeshTransfer(source, JSON.stringify(request), rgba), bytes => decodeAtlasOutput<MeshTransferPlan>(bytes));
}
export function runScanRegistration(request: ScanRegistrationRequest): Promise<ScanRegistrationReport> {
  return runAppearanceJob(api => api.registerScanCorrespondences(JSON.stringify(request)));
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

export function runCapturedMeshPlanning(source: Uint8Array, request: CapturedMeshRequest): Promise<CapturedMeshPlan> {
  return runAppearanceJob(api => api.planCapturedMesh(source, JSON.stringify(request)));
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
    if (!job || (job.type !== 'pdf-fidelity' && job.type !== 'pdf-fill-plan' && job.type !== 'mesh-transfer' && job.type !== 'scan-registration' && job.type !== 'plan' && job.type !== 'catalog' && job.type !== 'page-plan' && job.type !== 'annotation-plan' && job.type !== 'captured-mesh-plan')) return;
    try {
      const response: AppearanceWorkerResponse = job.type === 'pdf-fidelity'
        ? { type: 'pdf-fidelity-complete', id: job.id, result: await runPdfFidelity(job.request) }
        : job.type === 'pdf-fill-plan'
        ? { type: 'pdf-fill-complete', id: job.id, result: await runPdfFillAnnotationPlanning(job.source, job.request) }
        : job.type === 'mesh-transfer'
        ? { type: 'mesh-transfer-complete', id: job.id, result: await runMeshTransfer(job.source, job.request, job.rgba) }
        : job.type === 'scan-registration'
        ? { type: 'scan-registration-complete', id: job.id, result: await runScanRegistration(job.request) }
        : job.type === 'plan'
        ? { type: 'complete', id: job.id, plan: await runAppearancePlanning(job.source, job.request) }
        : job.type === 'catalog'
          ? { type: 'catalog-complete', id: job.id, catalog: await runAppearanceCatalog(job.source, job.request) }
          : job.type === 'captured-mesh-plan'
            ? { type: 'captured-mesh-complete', id: job.id, result: await runCapturedMeshPlanning(job.source, job.request) }
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
