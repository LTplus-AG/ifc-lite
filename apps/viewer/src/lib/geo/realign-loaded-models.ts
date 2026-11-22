/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { isModelLoadPending, watchLoadSupersession } from '@/hooks/modelLoadCanceller';
import { startWorkflowRun } from '@/lib/flow/run-session';
import type { NativeModelAdder } from '@/services/coordination-loader';
export class MissingAlignmentSourceError extends Error { constructor(readonly modelName: string) { super(`Model source unavailable: ${modelName}`); } }
export class ModelLoadPendingError extends Error { constructor() { super('A model is still loading'); } }
/** Drain ordinary add failures while this rebuild still owns the federation. */
export async function realignLoadedModels(addModel: NativeModelAdder) {
  const state = useViewerStore.getState(), snapshot = [...state.models.values()].sort((a, b) => (a.loadedAt ?? 0) - (b.loadedAt ?? 0));
  if (snapshot.length < 2) return { state: 'unchanged' as const, loaded: snapshot.length, total: snapshot.length, failed: [] as string[] };
  const missing = snapshot.find(model => !model.sourceFile); if (missing) throw new MissingAlignmentSourceError(missing.name);
  // Any unfinished load would land mid-rebuild; an admitted primary could even commit and clear the federation without aborting the later watch below (#11263).
  if (isModelLoadPending()) throw new ModelLoadPendingError();
  // clearAllModels also empties sourceTags; a reloaded model gets its tag back so revision checks keep seeing it.
  const tags = new Map(state.sourceTags);
  const workflow = startWorkflowRun('realign');
  const supersession = watchLoadSupersession('primary');
  const failed: string[] = [], reloadedIds: string[] = [];
  // A primary commit aborts the watch; a caller that clears models outside the lease (a multi-file open) removes a reloaded model.
  const replaced = () => supersession.signal.aborted || reloadedIds.some(id => !useViewerStore.getState().models.has(id));
  try {
    state.clearAllModels();
    for (const model of snapshot) {
      if (replaced()) break;
      const file = model.sourceFile; if (!file) continue;
      try {
        const id = await addModel(file, {
          name: model.name, modelId: model.id, loadedAt: model.loadedAt, visible: model.visible,
          collapsed: model.collapsed, workflowOwner: workflow.id,
        });
        if (replaced()) break;
        // Only a present, complete model with its original ID counts as reloaded.
        const reloaded = id ? useViewerStore.getState().models.get(id) : undefined;
        if (!reloaded || reloaded.id !== model.id || (reloaded.loadState && reloaded.loadState !== 'complete')) {
          failed.push(model.name);
          continue;
        }
        const tag = tags.get(model.id); if (tag) useViewerStore.getState().setSourceTag(reloaded.id, tag);
        if (model.visible === false) useViewerStore.getState().setModelVisibility(model.id, false);
        reloadedIds.push(model.id);
      } catch (error) {
        if (replaced()) break;
        console.warn('[georeference] A source could not be reloaded during realignment', error);
        failed.push(model.name);
      }
    }
    const result = replaced() ? 'superseded' : failed.length ? 'partial' : 'completed';
    return { state: result, loaded: reloadedIds.length, total: snapshot.length, failed };
  } finally {
    supersession.stop();
    workflow.release();
  }
}
