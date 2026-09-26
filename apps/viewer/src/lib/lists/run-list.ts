/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Run a list over the loaded federation (#5142): one `executeList` per
 * model in the list's tag scope, rows flattened, groups/summary re-derived
 * over the merged rows, execution-time column annotations merged back.
 *
 * Extracted from `ListPanel.handleExecuteList` so a document table block
 * runs a list through exactly the path the Lists panel does — same scope
 * rule, same federation merge, same unit annotations — without going
 * through the panel or its single `listResult` store slot.
 *
 * Throws what its parts throw (`scopeModelPairs` for an unresolved/empty
 * scope, `executeList` for a rejected name pattern): the caller decides
 * where the message is shown (#4317).
 */
import type { IfcDataStore } from '@ifc-lite/parser';
import type { ListDataProvider, ListDefinition, ListResult } from '@ifc-lite/lists';
import { executeList, summariseListRows } from '@ifc-lite/lists';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { evaluateFilterGroupsFederated, type EvaluatorModel } from '@ifc-lite/rules';
import { mergeResultColumns } from './merge-result-columns.js';
import { scopeModelPairs, type ListModelTagState } from './model-tag-scope.js';

/** One loaded model as the list engine sees it: its provider, keyed by the store's model id. */
export interface ModelProviderPair {
  modelId: string;
  provider: ListDataProvider;
  store: IfcDataStore;
  /** Only used by the single-model fallback when the canonical model list is empty. */
  mutationView?: MutablePropertyView;
}

export interface RunListOptions {
  /** Callers pass `evaluatorModelsFromState` so model identity, tags, and live
   * property edits have the same meaning as Search and Lens filters. */
  evaluatorModels?: readonly EvaluatorModel[];
  signal?: AbortSignal;
}

export async function runListFederated(
  definition: ListDefinition,
  pairs: readonly ModelProviderPair[],
  state: ListModelTagState,
  options: RunListOptions = {},
): Promise<ListResult> {
  // The list's model tag scope (#4215) decides which providers run; an
  // unresolved or empty scope throws its reason.
  const scoped = scopeModelPairs(definition, pairs, state);
  let parts: ListResult[];
  let scanDuration: number | undefined;
  if (definition.groups === undefined) {
    // V1 definitions still used by package consumers take their existing path.
    parts = scoped.map(({ modelId, provider }) => executeList(definition, provider, modelId));
  } else {
    const start = performance.now();
    // `executeList` remains the source-set and column engine. Its first pass
    // has no columns or presentation work: it applies the list's type/snapshot
    // scope plus only v1 predicates that lack a lossless Rules representation.
    // Once `groups` exists it is authoritative, even when the user cleared
    // every rule. `conditions` retains readable v1 rows only during migration.
    const unreadable = definition.unreadableConditions?.map(({ condition }) => condition) ?? [];
    const candidates = new Map(scoped.map(({ modelId, provider }) => [modelId, executeList({
      ...definition, conditions: unreadable, columns: [], grouping: undefined, sortBy: undefined,
    }, provider, modelId).rows.map(({ entityId }) => entityId)] as const));
    const hasRules = definition.groups.some((group) => group.rules.length > 0);
    const matchedByModel = new Map<string, Set<number>>();
    if (hasRules) {
      const canonical = new Map(options.evaluatorModels?.map((model) => [model.id, model] as const));
      const models: EvaluatorModel[] = scoped.map(({ modelId, store, mutationView }) => ({
        ...canonical.get(modelId), id: modelId, store,
        tagIds: state.modelTagAssignments.get(modelId),
        mutationView: canonical.get(modelId)?.mutationView ?? mutationView,
      }));
      const matched = await evaluateFilterGroupsFederated(models, definition.groups, {
        candidateExpressIdsByModel: candidates,
        definedModelTagIds: new Set(state.modelTags.keys()),
        limit: [...candidates.values()].reduce((count, ids) => count + ids.length, 0),
        signal: options.signal,
      });
      for (const { modelId, expressId } of matched) {
        let ids = matchedByModel.get(modelId);
        if (!ids) { ids = new Set(); matchedByModel.set(modelId, ids); }
        ids.add(expressId);
      }
    }
    parts = scoped.map(({ modelId, provider }) => executeList({
      ...definition, conditions: [],
      expressIdsByModel: { [modelId]: (candidates.get(modelId) ?? []).filter((id) => !hasRules || matchedByModel.get(modelId)?.has(id)) },
    }, provider, modelId));
    // Include the Rules scan in the user-visible execution time below.
    scanDuration = performance.now() - start;
  }

  const rows = parts.flatMap((r) => r.rows);
  const executionTime = scanDuration ?? parts.reduce((sum, r) => sum + r.executionTime, 0);

  // Re-derive groups/summary over the merged rows so grouping works across
  // federated models (and isn't dropped on the merge).
  const { groups, summary } = summariseListRows(definition, rows);

  // Merge each part's execution-time quantityType/dataType onto the columns
  // (#1573 follow-up): `definition.columns` alone never carries them, which
  // silently killed the export unit conversion.
  const columns = mergeResultColumns(parts, definition.columns);

  return { columns, rows, totalCount: rows.length, executionTime, groups, summary };
}
