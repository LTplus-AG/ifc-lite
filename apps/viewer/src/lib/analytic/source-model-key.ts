/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FederatedModel, ViewerState } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { selectedSourceRefs } from './selected-source-products';

/**
 * Every model field read by the selected-source query, the centreline build,
 * its snap curves and the federation anchor they align to, except `visible`.
 * A model row's own fields (`name`, `collapsed`) are not among them, so a new
 * `models` Map that only changes those neither moves nor rebuilds the selected
 * curves (#9158). `source-model-key.test.ts` checks that list against what
 * those paths read.
 */
export const SOURCE_MODEL_FIELDS = [
  'id', 'ifcDataStore', 'sourceFile', 'schemaVersion', 'loadFormat', 'geometryResult', 'preAlignment',
  'federationAlignmentStatus', 'spatialReference', 'loadedAt', 'idOffset', 'maxExpressId',
] as const satisfies readonly (keyof FederatedModel)[];

/**
 * What can place, re-source or re-anchor the selected curves, model by model.
 * Two equal keys cannot draw the curves anywhere else.
 */
export function sourceModelFrame(models: ViewerState['models']): unknown[] {
  const key: unknown[] = [models.size];
  for (const model of models.values()) {
    for (const field of SOURCE_MODEL_FIELDS) key.push(model[field]);
    // Alignment and placement can replace these on a kept object.
    key.push(model.ifcDataStore?.source, model.geometryResult?.coordinateInfo, model.preAlignment?.coordinateInfo);
  }
  return key;
}

/**
 * `visible` of each model that holds a selected product. Hiding or showing a
 * model the selection doesn't reach cannot change what the query loads.
 */
export function selectedModelVisibility(state: ViewerState): unknown[] {
  const holders = new Set([...selectedSourceRefs(state, resolveEntityRef).values()].map(({ modelId }) => modelId));
  const key: unknown[] = [];
  for (const model of state.models.values()) if (holders.has(model.id)) key.push(model.id, model.visible);
  return key;
}
