/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Tier1IndexRecord } from '@/store/slices/searchSlice.js';
import type { FederatedModel } from '@/store/types.js';
import { runTier0Scan, type SearchResult, type ScanModel } from './tier0-scan.js';
import { queryTier1Indexes, type Tier1Index } from './tier1-index.js';

/** The advanced search list and its Bulk target use the same capped, ordered result set. */
export const SEARCH_RESULT_LIMIT = 5000;

export function collectSearchResults(
  models: ReadonlyMap<string, FederatedModel>,
  indexes: ReadonlyMap<string, Tier1IndexRecord>,
  query: string,
): SearchResult[] {
  if (!query.trim()) return [];
  const tier0: ScanModel[] = [];
  const tier1: Tier1Index[] = [];
  for (const model of models.values()) {
    if (!model.ifcDataStore) continue;
    const record = indexes.get(model.id);
    if (record?.status === 'ready' && record.index) tier1.push(record.index);
    else tier0.push({ id: model.id, ifcDataStore: model.ifcDataStore });
  }
  const indexed = tier1.length ? queryTier1Indexes(tier1, query, { limit: SEARCH_RESULT_LIMIT }) : [];
  const scanned = tier0.length ? runTier0Scan(tier0, query, { limit: SEARCH_RESULT_LIMIT }) : [];
  if (!indexed.length) return scanned;
  if (!scanned.length) return indexed;
  const combined = [...indexed, ...scanned].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.modelId !== b.modelId) return a.modelId < b.modelId ? -1 : 1;
    return a.expressId - b.expressId;
  });
  const seen = new Set<string>();
  const result: SearchResult[] = [];
  for (const row of combined) {
    const key = `${row.modelId}:${row.expressId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
    if (result.length === SEARCH_RESULT_LIMIT) break;
  }
  return result;
}
