/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { evaluateFilterGroupsFederated, type FilterGroup } from '@ifc-lite/rules';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { ViewerState } from '@/store';
import { evaluatorModelsFromState, definedModelTagIdsOf } from '../model-tags/evaluator-models';

/** The message for a filter with no rules, which would otherwise widen the run to the whole model. */
export function targetFilterRefusal(groups: readonly FilterGroup[]): string | null {
  return groups.some(group => group.rules.length > 0) ? null : 'Add at least one object filter before running a filtered IDS check.';
}

/** Resolve the same edited values, IFC groups and saved groupings as Search.
 * The search UI's display limit must never truncate a validation population. */
export async function resolveIdsTargetFilter(state: ViewerState, modelId: string, dataStore: IfcDataStore,
  groups: readonly FilterGroup[], signal?: AbortSignal): Promise<number[]> {
  const refusal = targetFilterRefusal(groups);
  if (refusal) throw new Error(refusal);
  const canonical = evaluatorModelsFromState(state).find(model => model.id === modelId);
  const model = { ...canonical, id: modelId, store: dataStore, mutationView: state.getMutationView(modelId) ?? undefined };
  const matches = await evaluateFilterGroupsFederated([model], groups, {
    limit: Number.MAX_SAFE_INTEGER, signal, definedModelTagIds: definedModelTagIdsOf(state),
  });
  return [...new Set(matches.filter(match => match.modelId === modelId).map(match => match.expressId))];
}
