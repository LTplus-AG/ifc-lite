/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The ONE way the store's federation becomes the evaluator's model list
 * (#4215). Search, clash set filters and the SDK query adapter all used to
 * spell `{ id, filterIdentity: m.sourceFingerprint, store }` by hand; with
 * tags in the picture each would also have to remember the tag set and the
 * defined-tag set, and the one that forgot would silently evaluate every
 * `modelTag` rule as unresolved. So they all call this.
 *
 * Everything is read off the ONE `state` handed in: the tag sets are a
 * snapshot as of that call, which is what makes a clash run's membership
 * immune to re-tagging while it is in flight.
 */

import type { FederatedModel } from '../../store/types.js';
import type { ModelTagAssignments } from '../../store/slices/modelTagsSlice.js';
import type { EvaluatorModel } from '../search/filter-evaluate.js';
import type { ModelTag } from './types.js';

/** The slice of store state this reads. Structural so tests need no store. */
export interface ModelTagState {
  models: ReadonlyMap<string, Pick<FederatedModel, 'id' | 'sourceFingerprint' | 'ifcDataStore'>>;
  modelTags: ReadonlyMap<string, ModelTag>;
  modelTagAssignments: ModelTagAssignments;
}

/** Every loaded model with a store, as evaluator input, in federation order. */
export function evaluatorModelsFromState(state: ModelTagState): EvaluatorModel[] {
  const out: EvaluatorModel[] = [];
  for (const [id, m] of state.models) {
    out.push({
      id,
      filterIdentity: m.sourceFingerprint,
      tagIds: state.modelTagAssignments.get(id),
      store: m.ifcDataStore,
    });
  }
  return out;
}

/** The `definedModelTagIds` evaluator option for `state`. */
export function definedModelTagIdsOf(state: Pick<ModelTagState, 'modelTags'>): ReadonlySet<string> {
  return new Set(state.modelTags.keys());
}
