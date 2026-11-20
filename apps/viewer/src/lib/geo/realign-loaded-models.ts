/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import type { NativeModelAdder } from '@/services/coordination-loader';
export class MissingAlignmentSourceError extends Error { constructor(readonly modelName: string) { super(`Model source unavailable: ${modelName}`); } }
/** After clearing, drain every admitted source reload; cancellation cannot roll a partial rebuild back. */
export async function realignLoadedModels(addModel: NativeModelAdder) {
  const state = useViewerStore.getState(), snapshot = [...state.models.values()].sort((a, b) => (a.loadedAt ?? 0) - (b.loadedAt ?? 0));
  if (snapshot.length < 2) return { state: 'unchanged' as const, loaded: snapshot.length, total: snapshot.length, failed: [] as string[] };
  const missing = snapshot.find(model => !model.sourceFile); if (missing) throw new MissingAlignmentSourceError(missing.name);
  state.clearAllModels(); const failed: string[] = [];
  for (const model of snapshot) {
    const file = model.sourceFile; if (!file) continue;
    try {
      const id = await addModel(file, { name: model.name, modelId: model.id, loadedAt: model.loadedAt, visible: model.visible, collapsed: model.collapsed });
      // Only a present, complete model is reloaded: the same rule sources.loadModel applies.
      const reloaded = id ? useViewerStore.getState().models.get(id) : undefined;
      if (!reloaded || (reloaded.loadState && reloaded.loadState !== 'complete')) { failed.push(model.name); continue; }
      if (model.visible === false) useViewerStore.getState().setModelVisibility(model.id, false);
    } catch (error) { console.warn('[georeference] A source could not be reloaded during realignment', error); failed.push(model.name); }
  }
  return { state: failed.length ? 'partial' as const : 'completed' as const, loaded: snapshot.length - failed.length, total: snapshot.length, failed };
}
