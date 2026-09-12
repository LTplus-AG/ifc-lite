/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `elements` chart dataset from the loaded federation (#3944).
 *
 * One row per element instance across every loaded model, through the
 * package's typed-array fast path (`elementsDataset`), with the dashboard
 * scope applied as an include-set per model: everything, what is visible
 * right now (the same answer the lists "visible only" filter gives), or the
 * basket. Rows carry renderer ids (`expressId + idOffset`), so a bucket's ids
 * go straight to selection and visibility.
 */
import { elementsDataset, type ChartDataset, type ChartScope, type ElementsDatasetModel } from '@ifc-lite/charts';
import { useViewerStore, type ViewerState } from '@/store';
import { getVisibleBasketEntityRefsFromStore } from '@/store/basketVisibleSet';
import { stringToEntityRef, type EntityRef } from '@/store/types';

type ModelsState = Pick<ViewerState, 'models' | 'activeModelId' | 'pinboardEntities'>;

/** Per-model include sets for a scope, or `null` for "every element". */
function includeSets(scope: ChartScope, state: ModelsState): Map<string, Set<number>> | null {
  let refs: EntityRef[];
  if (scope.kind === 'visible') refs = getVisibleBasketEntityRefsFromStore();
  else if (scope.kind === 'basket') refs = [...state.pinboardEntities].map(stringToEntityRef);
  else return null; // 'all' — a 'list' scope is resolved by the caller into rows, not an include set
  const sets = new Map<string, Set<number>>();
  for (const ref of refs) {
    // Single-model rows are keyed 'legacy'/'default' by their producers while
    // `models` keys the same model by its id; fold them onto the active model.
    const modelId = state.models.has(ref.modelId) ? ref.modelId : (state.activeModelId ?? ref.modelId);
    let set = sets.get(modelId);
    if (!set) {
      set = new Set();
      sets.set(modelId, set);
    }
    set.add(ref.expressId);
  }
  return sets;
}

export function buildElementsDataset(scope: ChartScope, state: ModelsState = useViewerStore.getState()): ChartDataset {
  const includes = includeSets(scope, state);
  const models: ElementsDatasetModel[] = [];
  for (const model of state.models.values()) {
    const store = model.ifcDataStore;
    if (!store) continue;
    const include = includes?.get(model.id) ?? (includes ? new Set<number>() : undefined);
    models.push({ store, idOffset: model.idOffset ?? 0, name: model.name ?? model.id, include });
  }
  const dataset = elementsDataset(models);
  // The scope is part of the identity of the rows: the same models with a
  // different include set are a different dataset.
  return { ...dataset, fingerprint: `${scope.kind}:${dataset.fingerprint}` };
}
