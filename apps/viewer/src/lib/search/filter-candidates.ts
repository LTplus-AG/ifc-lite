/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { resolveCapturedEntityScope, type CapturedEntityScope, type EvaluatorModel } from '@ifc-lite/rules';
import { runTier0Scan, type ScanModel } from './tier0-scan';
import { queryTier1Indexes, type Tier1Index } from './tier1-index';

const TEXT_HIT_LIMIT = 50_000;
/** Native text and captured membership are intersecting source constraints,
 * never replacement alternatives. Explicit empties prevent missing model keys
 * from becoming Rules' default all-entity population. */
export function filterCandidates(
  models: readonly EvaluatorModel[],
  searchIndexes: ReadonlyMap<string, { status: string; index?: Tier1Index | null }>,
  query: string,
  scope?: CapturedEntityScope,
): Map<string, Iterable<number>> | undefined {
  const captured = scope ? resolveCapturedEntityScope(scope, models) : undefined;
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return captured;
  const t0Models: ScanModel[] = [];
  const t1Indexes: Tier1Index[] = [];
  for (const model of models) {
    const rec = searchIndexes.get(model.id);
    if (rec?.status === 'ready' && rec.index) t1Indexes.push(rec.index);
    else if (model.store) t0Models.push({ id: model.id, ifcDataStore: model.store });
  }
  const hits = [
    ...(t1Indexes.length ? queryTier1Indexes(t1Indexes, trimmedQuery, { limit: TEXT_HIT_LIMIT }) : []),
    ...(t0Models.length ? runTier0Scan(t0Models, trimmedQuery, { limit: TEXT_HIT_LIMIT }) : []),
  ];
  const candidates = new Map<string, Set<number>>(models.map(model => [model.id, new Set<number>()]));
  for (const hit of hits) {
    if (!captured || captured.get(hit.modelId)?.has(hit.expressId)) candidates.get(hit.modelId)?.add(hit.expressId);
  }
  return candidates;
}
