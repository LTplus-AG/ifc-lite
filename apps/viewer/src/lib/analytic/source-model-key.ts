/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FederatedModel, ViewerState } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { selectedSourceRefs } from './selected-source-products';
import { readsLiveAnchor } from './selected-centreline-lines';

/**
 * Every model field read by the selected-source query, the centreline build,
 * its snap curves and the federation anchor search, except `visible`. A model
 * row's own fields (`name`, `collapsed`) are not among them, so a new
 * `models` Map that only changes those neither moves nor rebuilds the selected
 * curves (#9158). `source-model-key.test.ts` checks that list against what
 * those paths read.
 */
export const SOURCE_MODEL_FIELDS = [
  'id', 'ifcDataStore', 'sourceFile', 'schemaVersion', 'loadFormat', 'geometryResult', 'preAlignment',
  'federationAlignmentStatus', 'alignmentReference', 'spatialReference', 'loadedAt', 'idOffset', 'maxExpressId',
] as const satisfies readonly (keyof FederatedModel)[];

function pushModel(key: unknown[], model: FederatedModel): void {
  for (const field of SOURCE_MODEL_FIELDS) key.push(model[field]);
  // Alignment and placement can replace these on a kept object.
  key.push(model.ifcDataStore?.source, model.geometryResult?.coordinateInfo, model.preAlignment?.coordinateInfo);
}

/** The models the selection names, by id, sorted: what `sourceModelFrame` and `selectedModelVisibility` key. */
export function selectedModelIds(state: ViewerState): string[] {
  return [...new Set([...selectedSourceRefs(state, resolveEntityRef).values()].map(({ modelId }) => modelId))].sort();
}

type FrameState = Pick<ViewerState, 'models' | 'anchorModelIdOverride' | 'ifcDataStore' | 'geometryResult'>;

/**
 * What can place, re-source or re-anchor the curves of products in the
 * `holders` models. Two equal keys cannot draw those curves anywhere else.
 *
 * Only the holders are keyed (#9229): a holder's curves read its own fields,
 * and an aligned holder maps through the reference it was re-baked into
 * (`alignmentReference`). Loading, streaming, removing or reordering another
 * model changes neither. A holder with no such record maps through the anchor
 * the federation picks now, which the pinned anchor and any model can change,
 * so that case keys every model and the pin. Without models, the legacy
 * single-file store and geometry place the curves.
 */
export function sourceModelFrame(state: FrameState, holders: readonly string[]): unknown[] {
  const { models } = state;
  if (models.size === 0) {
    const legacy = state.geometryResult;
    return [0, state.ifcDataStore, state.ifcDataStore?.source, legacy, legacy?.coordinateInfo];
  }
  const live = holders.some((id) => {
    const model = models.get(id);
    return model !== undefined && readsLiveAnchor(model);
  });
  if (live) {
    const key: unknown[] = ['anchor', state.anchorModelIdOverride, models.size];
    for (const model of models.values()) pushModel(key, model);
    return key;
  }
  const key: unknown[] = ['holders'];
  for (const id of holders) {
    const model = models.get(id);
    key.push(id, model !== undefined);
    if (model) pushModel(key, model);
  }
  return key;
}

/**
 * `visible` of each model that holds a selected product. Hiding or showing a
 * model the selection doesn't reach cannot change what the query loads.
 */
export function selectedModelVisibility(state: ViewerState, holders: readonly string[] = selectedModelIds(state)): unknown[] {
  const key: unknown[] = [];
  for (const id of holders) {
    const model = state.models.get(id);
    if (model) key.push(id, model.visible);
  }
  return key;
}
