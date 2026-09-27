/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo } from 'react';
import { useViewerStore } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import type { FederatedModel } from '@/store/types';
import { collectSearchResults } from '@/lib/search/collect-results';
import { filterResultToSearchResults } from '@/lib/search/filter-result-to-search-results';
import { groupBulkTargets, searchedBulkTargets, selectedBulkTargets, type BulkTargetSource } from './bulk-targets';

/** The source snapshot shown beside Run. Execute takes a fresh snapshot. */
export function useBulkTargets(
  open: boolean,
  source: BulkTargetSource,
  models: ReadonlyMap<string, FederatedModel>,
): Map<string, number[]> {
  const selectedEntityIds = useViewerStore((s) => s.selectedEntityIds);
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const searchQuery = useViewerStore((s) => s.searchQuery);
  const searchIndexes = useViewerStore((s) => s.searchIndexes);
  const searchModalTab = useViewerStore((s) => s.searchModalTab);
  const searchFilterResult = useViewerStore((s) => s.searchFilterResult);
  const searchFieldFilter = useViewerStore((s) => s.searchFieldFilter);
  const searchModelFilter = useViewerStore((s) => s.searchModelFilter);

  return useMemo(() => {
    if (!open || source === 'query') return new Map();
    if (source === 'selection') {
      const ids = selectedEntityIds.size ? selectedEntityIds : selectedEntityId === null ? [] : [selectedEntityId];
      return groupBulkTargets(selectedBulkTargets(ids, resolveEntityRef)
        .filter(({ modelId }) => models.get(modelId)?.ifcDataStore));
    }
    const results = searchModalTab === 'filter'
      ? searchFilterResult
        ? filterResultToSearchResults(searchFilterResult, models.size === 1 ? models.keys().next().value ?? null : null)
        : []
      : collectSearchResults(models, searchIndexes, searchQuery).filter((result) =>
        (searchFieldFilter === 'all' || result.matchField === searchFieldFilter)
        && (!searchModelFilter || searchModelFilter.has(result.modelId)));
    return groupBulkTargets(searchedBulkTargets(results)
      .filter(({ modelId }) => models.get(modelId)?.ifcDataStore));
  }, [open, source, models, selectedEntityIds, selectedEntityId, searchQuery, searchIndexes,
    searchModalTab, searchFilterResult, searchFieldFilter, searchModelFilter]);
}
