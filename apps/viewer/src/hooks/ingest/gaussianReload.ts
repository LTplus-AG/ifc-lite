/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback } from 'react';
import { useViewerStore } from '@/store';
import { captureModelTags, restoreModelTags } from '@/lib/model-tags/carry-over';
import type { FederationAddModelOptions } from '../modelLoadOptions.js';
import { useIfcLoader } from '../useIfcLoader.js';
import { useIfcFederation } from '../useIfcFederation.js';

export type GaussianReloadResult =
  | { ok: true; modelId: string }
  | { ok: false; reason: 'not-a-capture' | 'source-unavailable' | 'not-loaded' };

export interface GaussianReloadDeps {
  addModel(file: File, options: FederationAddModelOptions): Promise<string | null>;
  removeModel(modelId: string): void;
}

/**
 * Reload a capture from the File it was opened from (#8566). A failed handle
 * is terminal and a replaced renderer never received the asset, so the only
 * way back is the canonical loader again: admission is re-decided (public
 * builds still refuse), an explicit placement is replayed, and a raw-source
 * placement stays raw. Without a retained source the reload refuses.
 */
// Shared by hierarchy/properties hooks: one source model owns one replacement.
const transactions = new Map<string, Promise<GaussianReloadResult>>();

export function reloadGaussianCapture(modelId: string, deps: GaussianReloadDeps): Promise<GaussianReloadResult> {
  const pending = transactions.get(modelId);
  if (pending) return pending;
  // Defer execution until ownership is installed, including re-entrant calls.
  const transaction = Promise.resolve().then(() => replaceCapture(modelId, deps)).finally(() => {
    if (transactions.get(modelId) === transaction) transactions.delete(modelId);
  });
  transactions.set(modelId, transaction);
  return transaction;
}

async function replaceCapture(modelId: string, deps: GaussianReloadDeps): Promise<GaussianReloadResult> {
  const model = useViewerStore.getState().models.get(modelId);
  const capture = model?.gaussianSplat;
  if (!model || !capture) return { ok: false, reason: 'not-a-capture' };
  if (!model.sourceFile) return { ok: false, reason: 'source-unavailable' };
  const { sourceFile, sourceHandle, name, visible, collapsed } = model;
  const replacementId = crypto.randomUUID();
  let committed = false;
  try {
    const next = await deps.addModel(sourceFile, {
      modelId: replacementId,
      name, visible, collapsed, sourceHandle, gaussianAttribution: capture.attribution,
      retryOperation: () => { void reloadGaussianCapture(modelId, deps); },
      ...(capture.placementOrigin === 'explicit' ? { gaussianPlacement: [...capture.placement] } : {}),
    });
    const state = useViewerStore.getState();
    // A superseded federation add can publish but return null. The explicit
    // id lets finally release that losing asset without touching another load.
    // Removal/replacement of the source while awaiting also cancels this swap.
    if (next !== replacementId || !state.models.get(replacementId)?.gaussianSplat
      || state.models.get(modelId)?.gaussianSplat?.handle !== capture.handle) {
      return { ok: false, reason: 'not-loaded' };
    }
    const tags = captureModelTags(state, [modelId]);
    restoreModelTags(state, tags, modelId, replacementId);
    deps.removeModel(modelId);
    committed = true;
    return { ok: true, modelId: replacementId };
  } finally {
    if (!committed && useViewerStore.getState().models.has(replacementId)) deps.removeModel(replacementId);
  }
}

/** The reload action bound to this component's canonical loader. */
export function useGaussianReload(): (modelId: string) => Promise<GaussianReloadResult> {
  const { addModel, removeModel } = useIfcFederation(useIfcLoader().loadFile);
  return useCallback((modelId: string) => reloadGaussianCapture(modelId, { addModel, removeModel }), [addModel, removeModel]);
}
