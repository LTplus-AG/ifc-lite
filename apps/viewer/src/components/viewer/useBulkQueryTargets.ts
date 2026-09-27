/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import { evaluateFilterGroupsFederated, type EvaluatorModel, type FilterGroup } from '@ifc-lite/rules';
import { BulkQueryEngine, MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type ViewerState } from '@/store';
import { definedModelTagIdsOf, evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';

/** Evaluate exactly the selected model against the shared rule vocabulary. */
export async function resolveBulkQueryIds(
  state: ViewerState,
  modelId: string,
  groups: readonly FilterGroup[],
  signal?: AbortSignal,
): Promise<number[]> {
  signal?.throwIfAborted();
  const model = evaluatorModelsFromState(state).find((entry) => entry.id === modelId);
  const legacy: EvaluatorModel | undefined = modelId === '__legacy__' && state.ifcDataStore
    ? { id: modelId, store: state.ifcDataStore, mutationView: state.mutationViews.get(modelId) }
    : undefined;
  const target = model ?? legacy;
  if (!target?.store) return [];
  // An untouched Query has always addressed the whole effective model.
  // Rules treats an empty group as no result; the engine's candidate
  // iterator preserves the historical no-predicate selection, including
  // created entities and tombstones.
  if (groups.every((group) => group.rules.length === 0)) {
    return new BulkQueryEngine(target.store.entities,
      target.mutationView ?? new MutablePropertyView(target.store.properties, modelId)).select({});
  }
  const matched = await evaluateFilterGroupsFederated([target], groups, {
    limit: Number.MAX_SAFE_INTEGER,
    chunkSize: 20_000,
    signal,
    definedModelTagIds: definedModelTagIdsOf(state),
  });
  return matched.map((entry) => entry.expressId);
}

/** The count beside Run always belongs to the current editor/model snapshot. */
export function useBulkQueryTargets(open: boolean, suspended: boolean, modelId: string, groups: readonly FilterGroup[]) {
  const mutationVersion = useViewerStore((state) => state.mutationVersion);
  const [ids, setIds] = useState<number[]>([]);
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    if (!open || !modelId) {
      setIds([]);
      setComputing(false);
      setError(null);
      return () => controller.abort();
    }
    // A Bulk run increments mutationVersion after every written chunk. Keep
    // its displayed snapshot until the run ends, then refresh it once.
    if (suspended) return () => controller.abort();
    setIds([]);
    setComputing(true);
    setError(null);
    void resolveBulkQueryIds(useViewerStore.getState(), modelId, groups, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setIds(next);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        console.error('[bulk-edit] rule query failed', cause);
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setComputing(false);
      });
    return () => controller.abort();
  }, [open, suspended, modelId, groups, mutationVersion]);

  return { ids, computing, error };
}
