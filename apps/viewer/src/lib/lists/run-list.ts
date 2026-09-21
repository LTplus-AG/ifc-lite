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
import { mergeResultColumns } from './merge-result-columns.js';
import { scopeModelPairs, type ListModelTagState } from './model-tag-scope.js';

/** One loaded model as the list engine sees it: its provider, keyed by the store's model id. */
export interface ModelProviderPair {
  modelId: string;
  provider: ListDataProvider;
  store: IfcDataStore;
}

export function runListFederated(
  definition: ListDefinition,
  pairs: readonly ModelProviderPair[],
  state: ListModelTagState,
): ListResult {
  const parts: ListResult[] = [];
  // The list's model tag scope (#4215) decides which providers run; an
  // unresolved or empty scope throws its reason.
  for (const { modelId, provider } of scopeModelPairs(definition, pairs, state)) {
    parts.push(executeList(definition, provider, modelId));
  }

  const rows = parts.flatMap((r) => r.rows);
  const executionTime = parts.reduce((sum, r) => sum + r.executionTime, 0);

  // Re-derive groups/summary over the merged rows so grouping works across
  // federated models (and isn't dropped on the merge).
  const { groups, summary } = summariseListRows(definition, rows);

  // Merge each part's execution-time quantityType/dataType onto the columns
  // (#1573 follow-up): `definition.columns` alone never carries them, which
  // silently killed the export unit conversion.
  const columns = mergeResultColumns(parts, definition.columns);

  return { columns, rows, totalCount: rows.length, executionTime, groups, summary };
}
