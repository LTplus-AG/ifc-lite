/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { federationFrameInfo } from '@ifc-lite/geometry/world-frame';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GaussianReadiness, Renderer } from '@ifc-lite/renderer';
import { computeSourceFingerprintFromBlob } from '@ifc-lite/cache';
import { useViewerStore } from '@/store';
import { identifyLoadedPlacementSource } from '@/lib/model-placement/loaded-source-identity';
import { frameModels } from '@/lib/model-placement/scene';
import { getGlobalRenderer } from '../useBCF.js';
import type { CaptureFailureCode } from '@/lib/analytics-capture-events';
import type { GaussianAdmission } from './gaussianAdmission.js';
import type { GaussianLoadOutcome, ModelLoadOptions } from '../modelLoadOptions.js';
import { gaussianAdmissionEnabled, showcaseGaussianPlacement } from './gaussianAdmissionPolicy.js';
import { adoptGaussianAsset } from './gaussianAssets.js';
import { gaussianModelShell, prepareGaussianCapture, uploadGaussianCapture, type GaussianSplatModel } from './gaussianIngest.js';
import { captureLoadFailure, captureRefusal, type CaptureRefusal } from './gaussianRefusals.js';
import { reserveSceneSplats } from './gaussianSceneBudget.js';
import { reportCaptureLoad } from './gaussianTelemetry.js';
import { decodeGaussianInWorker } from './gaussianWorker.js';

export interface GaussianLoadContext {
  file: File;
  admission: Exclude<GaussianAdmission, { kind: 'ordinary' }>;
  target: { kind: 'primary' | 'federated'; visible?: boolean };
  modelId: string;
  /** Caller/user placement and credit; admission itself is the build's (`gaussianAdmissionEnabled`). */
  options?: Pick<ModelLoadOptions, 'gaussianPlacement' | 'gaussianUpAxis' | 'gaussianAttribution' | 'gaussianReplacingModelId' | 'onGaussianBudgetReserved'>;
  /** The load's own cancellation: it terminates the decoder worker and the upload. */
  signal: AbortSignal;
  isCurrent(): boolean;
  showLoadError(message: string, code: string): void;
  finalize(dataStore: IfcDataStore, geometryResult: GeometryResult, schemaVersion: 'IFC4',
    patch: { gaussianSplat: GaussianSplatModel; loadPath: 'gaussian' }): Promise<void>;
  /** In-process decoder seam for tests; production decodes in the dedicated worker. */
  decode?: typeof decodeGaussianInWorker;
}

/**
 * Gaussian PLY/.splat through the canonical loader (#8565/#8568): admission
 * and launch limits -> renderer readiness -> scene budget -> worker decode ->
 * normalized upload -> store publication. Every exit before adoption leaves no
 * worker, renderer asset, budget hold or model-index reservation; a superseded
 * load writes no UI or store state. Each settled load reports content-free
 * diagnostics (outcome, code, format, size and splat buckets).
 */
export async function loadGaussianCapture(ctx: GaussianLoadContext): Promise<GaussianLoadOutcome> {
  let failure: { code: CaptureFailureCode; refused: boolean } | undefined;
  let outcome: GaussianLoadOutcome = 'failed';
  try {
    outcome = await runGaussianCapture(ctx, (code, refused) => { failure = { code, refused }; });
    return outcome;
  } finally {
    reportCaptureLoad({
      outcome: outcome === 'failed' ? (failure?.refused ? 'refused' : 'failed') : outcome,
      code: failure?.code ?? 'gaussian_load_failed',
      format: ctx.admission.format ?? 'gaussian-ply', bytes: ctx.file.size,
      count: ctx.admission.kind === 'capture' ? ctx.admission.count
        : ctx.admission.breach?.limit === 'capture-splats' ? ctx.admission.breach.count : undefined,
    });
  }
}

async function runGaussianCapture(ctx: GaussianLoadContext, noteFailure: (code: CaptureFailureCode, refused: boolean) => void): Promise<GaussianLoadOutcome> {
  const store = useViewerStore.getState();
  const fail = (message: string, code: CaptureFailureCode, refused = false): GaussianLoadOutcome => {
    noteFailure(code, refused);
    ctx.showLoadError(message, code);
    if (ctx.target.kind === 'primary') store.updateModel(ctx.modelId, { loadState: 'error', loadError: message });
    store.setLoading(false);
    return 'failed';
  };
  const refuse = ({ message, code }: CaptureRefusal) => fail(message, code, true);
  // The kill switch refuses every capture, well formed or not, before decoding.
  if (!gaussianAdmissionEnabled()) return refuse(captureRefusal({ kind: 'disabled' }));
  if (ctx.admission.kind === 'invalid') {
    return refuse(ctx.admission.breach ? captureRefusal({ kind: 'limit', breach: ctx.admission.breach })
      : { message: ctx.admission.reason, code: 'gaussian_invalid_input' });
  }
  // The viewer has a renderer only on a WebGPU device; captures need nothing less.
  const renderer = getGlobalRenderer();
  if (!renderer) return refuse(captureRefusal({ kind: 'webgpu' }));
  const readiness = await settledReadiness(renderer);
  if (!ctx.isCurrent()) return 'cancelled';
  if (readiness.state !== 'blocked' || readiness.upstream === 'missing') {
    return refuse(captureRefusal({ kind: 'renderer', state: readiness.state }));
  }
  const budget = reserveSceneSplats(ctx.admission.count, useViewerStore.getState().models, ctx.options?.gaussianReplacingModelId, ctx.modelId);
  if (!budget.ok) return refuse(captureRefusal({ kind: 'scene', total: budget.total, limit: budget.limit }));
  let transferred = false;
  try {
    if (ctx.options?.gaussianReplacingModelId && ctx.options.onGaussianBudgetReserved) {
      ctx.options.onGaussianBudgetReserved(budget.release);
      transferred = true;
    }
    // Reload owns its logical scene share through the swap, including the
    // fingerprint await after publication. Ordinary loads release on adoption.
    return await decodeAndPublish(ctx, ctx.admission.format, renderer, readiness.generation,
      () => { if (!transferred) budget.release(); }, fail);
  } finally {
    if (!transferred) budget.release();
  }
}

/** After every refusal: decode, upload, publish. `releaseBudget` once the store counts the capture. */
async function decodeAndPublish(
  ctx: GaussianLoadContext, format: GaussianSplatModel['format'], renderer: Renderer, generation: number,
  releaseBudget: () => void, fail: (message: string, code: CaptureFailureCode) => GaussianLoadOutcome,
): Promise<GaussianLoadOutcome> {
  const store = useViewerStore.getState();
  const splats = renderer.gaussianSplats;
  store.setProgress({ phase: `Decoding ${format === 'splat' ? '.splat' : 'Gaussian PLY'} capture`, percent: 10 });
  let upload: Awaited<ReturnType<typeof uploadGaussianCapture>>;
  try {
    const capture = prepareGaussianCapture(await (ctx.decode ?? decodeGaussianInWorker)(ctx.file, ctx.signal));
    if (!ctx.isCurrent()) return 'cancelled';
    store.setProgress({ phase: 'Uploading Gaussian capture', percent: 70 });
    upload = await uploadGaussianCapture({
      modelId: ctx.modelId, format, capture, splats, generation,
      currentGeneration: () => blockedGeneration(renderer), models: () => useViewerStore.getState().models,
      visible: ctx.target.visible ?? true, signal: ctx.signal, isCurrent: ctx.isCurrent,
      upAxis: ctx.options?.gaussianUpAxis,
      frame: federationFrameInfo([...useViewerStore.getState().models.values()].filter(m => !m.gaussianSplat && m.id !== ctx.modelId), useViewerStore.getState().geometryResult),
      placement: ctx.options?.gaussianPlacement ?? showcaseGaussianPlacement(), attribution: ctx.options?.gaussianAttribution,
    });
  } catch (error) {
    // A superseded or cancelled load: its canceller or successor owns the UI.
    if (!ctx.isCurrent()) return 'cancelled';
    return fail(captureLoadFailure(error instanceof Error ? error.message : String(error)), 'gaussian_load_failed');
  }
  if (!upload) return ctx.isCurrent() ? 'failed' : 'cancelled';
  const shell = gaussianModelShell(ctx.file.size);
  try {
    await ctx.finalize(shell.dataStore, shell.geometryResult, 'IFC4', { gaussianSplat: upload.record, loadPath: 'gaussian' });
  } catch (error) {
    upload.rollback();
    throw error;
  }
  if (useViewerStore.getState().models.get(ctx.modelId)?.gaussianSplat?.handle !== upload.record.handle) {
    upload.rollback(); // Finalization declined: superseded before publication.
    return ctx.isCurrent() ? 'failed' : 'cancelled';
  }
  adoptGaussianAsset(ctx.modelId, upload.record.handle, splats);
  upload.commit();
  releaseBudget(); // The store now counts this capture's splats.
  if (!ctx.isCurrent()) return 'cancelled';
  const fingerprint = await computeSourceFingerprintFromBlob(ctx.file);
  if (!ctx.isCurrent()) return 'cancelled';
  if (useViewerStore.getState().models.has(ctx.modelId)) {
    store.updateModel(ctx.modelId, { sourceFingerprint: `${ctx.file.name}:${fingerprint.hex}`, loadFormat: format });
    void identifyLoadedPlacementSource(ctx.modelId, ctx.file);
  }
  // A primary capture, or one opened into an empty scene, has no other framing.
  if (ctx.target.kind === 'primary' || useViewerStore.getState().models.size === 1) {
    try { frameModels([ctx.modelId]); } catch { /* bounds pending: the user can fit later */ }
  }
  store.setProgress({ phase: 'Complete', percent: 100 });
  store.setLoading(false);
  return ctx.isCurrent() ? 'completed' : 'cancelled';
}

/** Wait out initialization only; loss and disposal are reported, not awaited. */
async function settledReadiness(renderer: Renderer): Promise<GaussianReadiness> {
  if (renderer.getGaussianReadiness().state === 'initializing') {
    try { await renderer.whenReady(); } catch { /* reported by the readiness below */ }
  }
  return renderer.getGaussianReadiness();
}

function blockedGeneration(renderer: Renderer): number | undefined {
  const readiness = renderer.getGaussianReadiness();
  return readiness.state === 'blocked' ? readiness.generation : undefined;
}
