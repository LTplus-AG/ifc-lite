/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL file was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { prepareMutationViewMerge, type MutablePropertyView } from '@ifc-lite/mutations';
import { isLegacyMutationRef, LEGACY_MUTATION_MODEL_IDS } from '@/sdk/adapters/model-compat';
import type { ViewerState } from '../index.js';
import { dropFromChangeSets } from './mutation-history-record.js';
import { invalidateHistoryPatch } from './mutation-redo-remote-guard.js';

export function registerOverlayView(
  state: ViewerState,
  modelId: string,
  view: MutablePropertyView,
): Partial<ViewerState> {
  const mutationViews = new Map(state.mutationViews).set(modelId, view);
  if (!isLegacyMutationRef(state, modelId)) return { mutationViews };

  const aliases = LEGACY_MUTATION_MODEL_IDS.flatMap(id => {
    const aliasView = mutationViews.get(id);
    return aliasView ? [[id, aliasView] as const] : [];
  });
  const [primary, ...others] = aliases;
  if (!primary || others.length === 0) return { mutationViews };

  const merge = prepareMutationViewMerge(primary[1], others.map(([, aliasView]) => aliasView));
  let history = {
    undoStacks: state.undoStacks, redoStacks: state.redoStacks,
    mutationBatchTags: state.mutationBatchTags, mutationMeshTranslations: state.mutationMeshTranslations,
  };
  const discarded = new Set<string>();
  for (const id of LEGACY_MUTATION_MODEL_IDS) {
    const records = [...(state.undoStacks.get(id) ?? []), ...(state.redoStacks.get(id) ?? [])];
    for (const mutation of records) if (merge.isShadowed(mutation)) {
      if (state.mutationBatchTags.has(mutation.id)) {
        throw new Error('Conflicting edits belong to a combined undo step.');
      }
      discarded.add(mutation.id);
    }
    const { collabGeometryNotice: _notice, ...patch } = invalidateHistoryPatch(
      history.undoStacks, history.redoStacks, history.mutationBatchTags, history.mutationMeshTranslations,
      id, mutation => discarded.has(mutation.id),
    );
    history = { ...history, ...patch };
  }

  const storeEditors = new Map(state.storeEditors);
  for (const [id] of aliases) storeEditors.delete(id);
  for (const [id] of others) mutationViews.delete(id);
  const changeSets = dropFromChangeSets(state, discarded);
  merge.commit();
  return { mutationViews, storeEditors, ...history, ...changeSets, mutationVersion: state.mutationVersion + 1 };
}
