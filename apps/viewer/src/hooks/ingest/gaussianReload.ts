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
export async function reloadGaussianCapture(modelId: string, deps: GaussianReloadDeps): Promise<GaussianReloadResult> {
  const model = useViewerStore.getState().models.get(modelId);
  const capture = model?.gaussianSplat;
  if (!model || !capture) return { ok: false, reason: 'not-a-capture' };
  if (!model.sourceFile) return { ok: false, reason: 'source-unavailable' };
  const { sourceFile, sourceHandle, name, visible, collapsed } = model;
  const next = await deps.addModel(sourceFile, {
    name, visible, collapsed, sourceHandle, gaussianAttribution: capture.attribution,
    ...(capture.placementOrigin === 'explicit' ? { gaussianPlacement: [...capture.placement] } : {}),
  });
  if (!next) return { ok: false, reason: 'not-loaded' };
  // Keep the retry row (and its owned asset) until admission and loading
  // succeed. Read tags at commit time so edits during the load survive too.
  const state = useViewerStore.getState();
  const tags = captureModelTags(state, [modelId]);
  restoreModelTags(state, tags, modelId, next);
  deps.removeModel(modelId);
  return { ok: true, modelId: next };
}

/** The reload action bound to this component's canonical loader. */
export function useGaussianReload(): (modelId: string) => Promise<GaussianReloadResult> {
  const { addModel, removeModel } = useIfcFederation(useIfcLoader().loadFile);
  return useCallback((modelId: string) => reloadGaussianCapture(modelId, { addModel, removeModel }), [addModel, removeModel]);
}
