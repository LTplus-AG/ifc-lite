/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { evaluateFilterGroupsFederated } from '@ifc-lite/rules';
import type { ViewerState } from '@/store';
import type { SearchFilterStateValue } from '@/store/slices/searchSlice';
import { definedModelTagIdsOf, evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import { filterCandidates } from './filter-candidates';
/** The Search modal and operations share text/captured-scope intersection,
 * effective model tags, native Rules evaluation and result-column layout. */
export async function evaluateViewerFilter(state: ViewerState, filter: SearchFilterStateValue, query: string, options: {
  signal?: AbortSignal; onProgress?: (scanned: number, total: number) => void;
} = {}) {
  const start = performance.now();
  const models = evaluatorModelsFromState(state).filter(model => model.store);
  const candidates = filterCandidates(models, state.searchIndexes, query, filter.capturedScope);
  const limit = filter.limit > 0 ? filter.limit : 5000;
  const matched = await evaluateFilterGroupsFederated(models, filter.groups, {
    limit, definedModelTagIds: definedModelTagIdsOf(state), chunkSize: 20_000,
    candidateExpressIdsByModel: candidates, signal: options.signal, onProgress: options.onProgress,
  });
  const multiple = models.length > 1;
  const columns = multiple ? ['express_id', 'global_id', 'name', 'type', 'model_id'] : ['express_id', 'global_id', 'name', 'type'];
  const rows: unknown[][] = matched.map(row => multiple
    ? [row.expressId, row.globalId, row.name, row.ifcType, row.modelId]
    : [row.expressId, row.globalId, row.name, row.ifcType]);
  return { result: { columns, rows, runMs: Math.round(performance.now() - start) }, limitHit: matched.length >= limit ? limit : null };
}
