/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GaussianReadiness, Renderer } from '@ifc-lite/renderer';
import { computeSourceFingerprintFromBlob } from '@ifc-lite/cache';
import { useViewerStore } from '@/store';
import { identifyLoadedPlacementSource } from '@/lib/model-placement/loaded-source-identity';
import { frameModels } from '@/lib/model-placement/scene';
import { getGlobalRenderer } from '../useBCF.js';
import type { GaussianAdmission } from './gaussianAdmission.js';
import type { ModelLoadOptions } from '../modelLoadOptions.js';
import { resolveGaussianQualification, showcaseGaussianPlacement } from './gaussianAdmissionPolicy.js';
import { adoptGaussianAsset } from './gaussianAssets.js';
import { gaussianModelShell, prepareGaussianCapture, uploadGaussianCapture, type GaussianSplatModel } from './gaussianIngest.js';
import { decodeGaussianInWorker } from './gaussianWorker.js';

export interface GaussianLoadContext {
  file: File;
  admission: Exclude<GaussianAdmission, { kind: 'ordinary' }>;
  target: { kind: 'primary' | 'federated'; visible?: boolean };
  modelId: string;
  /** Explicit opt-in, placement and credit; see `resolveGaussianQualification`. */
  options?: Pick<ModelLoadOptions, 'gaussianQualification' | 'gaussianPlacement' | 'gaussianAttribution'>;
  /** The load's own cancellation: it terminates the decoder worker and the upload. */
  signal: AbortSignal;
  isCurrent(): boolean;
  showLoadError(message: string, code: string): void;
  finalize(dataStore: IfcDataStore, geometryResult: GeometryResult, schemaVersion: 'IFC4',
    patch: { gaussianSplat: GaussianSplatModel; loadPath: 'gaussian' }): Promise<void>;
  /** In-process decoder seam for tests; production decodes in the dedicated worker. */
  decode?: typeof decodeGaussianInWorker;
}

const DISABLED = 'Gaussian splat loading is disabled pending the native rendering contract.';

/**
 * Gaussian PLY/.splat through the canonical loader (#8565): admission ->
 * renderer readiness -> worker decode -> normalized upload -> store
 * publication. Every exit before adoption leaves no worker, renderer asset or
 * model-index reservation; a superseded load writes no UI or store state.
 */
export async function loadGaussianCapture(ctx: GaussianLoadContext): Promise<void> {
  const store = useViewerStore.getState();
  const fail = (message: string, code: string) => {
    ctx.showLoadError(message, code);
    if (ctx.target.kind === 'primary') store.updateModel(ctx.modelId, { loadState: 'error', loadError: message });
    store.setLoading(false);
  };
  if (ctx.admission.kind === 'invalid') return fail(ctx.admission.reason, 'gaussian_invalid_input');
  if (!resolveGaussianQualification(ctx.options?.gaussianQualification)) return fail(DISABLED, 'gaussian_disabled');
  const renderer = getGlobalRenderer();
  if (!renderer) return fail('Renderer not initialised; the capture was not decoded.', 'renderer_not_ready');
  const splats = renderer.gaussianSplats; // internal, unqualified adapter (#8564)
  const readiness = await settledReadiness(renderer);
  if (!ctx.isCurrent()) return;
  if (readiness.state !== 'blocked' || readiness.reasons.includes('upstream-capability-missing')) {
    return fail(readiness.state === 'lost'
      ? 'The graphics device was lost; reload the page and open the capture again.'
      : 'The viewer renderer cannot accept Gaussian captures right now; the capture was not decoded.', `gaussian_renderer_${readiness.state}`);
  }
  const format = ctx.admission.format;
  store.setProgress({ phase: `Decoding ${format === 'splat' ? '.splat' : 'Gaussian PLY'} capture`, percent: 10 });
  let upload: Awaited<ReturnType<typeof uploadGaussianCapture>>;
  try {
    const capture = prepareGaussianCapture(await (ctx.decode ?? decodeGaussianInWorker)(ctx.file, ctx.signal));
    if (!ctx.isCurrent()) return;
    store.setProgress({ phase: 'Uploading Gaussian capture', percent: 70 });
    upload = await uploadGaussianCapture({
      modelId: ctx.modelId, format, capture, splats, generation: readiness.generation,
      currentGeneration: () => blockedGeneration(renderer), models: () => useViewerStore.getState().models,
      visible: ctx.target.visible ?? true, signal: ctx.signal, isCurrent: ctx.isCurrent,
      placement: ctx.options?.gaussianPlacement ?? showcaseGaussianPlacement(), attribution: ctx.options?.gaussianAttribution,
    });
  } catch (error) {
    // A superseded or cancelled load: its canceller or successor owns the UI.
    if (!ctx.isCurrent()) return;
    return fail(`Gaussian capture could not be loaded: ${error instanceof Error ? error.message : String(error)}`, 'gaussian_load_failed');
  }
  if (!upload) return;
  const shell = gaussianModelShell(ctx.file.size);
  try {
    await ctx.finalize(shell.dataStore, shell.geometryResult, 'IFC4', { gaussianSplat: upload.record, loadPath: 'gaussian' });
  } catch (error) {
    upload.rollback();
    throw error;
  }
  if (useViewerStore.getState().models.get(ctx.modelId)?.gaussianSplat?.handle !== upload.record.handle) {
    upload.rollback(); // Finalization declined: superseded before publication.
    return;
  }
  adoptGaussianAsset(ctx.modelId, upload.record.handle, splats);
  upload.commit();
  if (!ctx.isCurrent()) return;
  const fingerprint = await computeSourceFingerprintFromBlob(ctx.file);
  if (!ctx.isCurrent()) return;
  if (useViewerStore.getState().models.has(ctx.modelId)) {
    store.updateModel(ctx.modelId, { sourceFingerprint: `${ctx.file.name}:${fingerprint.hex}`, loadFormat: format });
    void identifyLoadedPlacementSource(ctx.modelId, ctx.file);
  }
  if (ctx.target.kind === 'primary') {
    try { frameModels([ctx.modelId]); } catch { /* bounds pending: the user can fit later */ }
  }
  store.setProgress({ phase: 'Complete', percent: 100 });
  store.setLoading(false);
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
