/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Lists table's "Visible only" filter: keep the rows whose entity is
 * visible in 3D, re-filtering whenever any visibility input changes.
 *
 * While the list itself is isolating (a group row's Isolate action, #6368),
 * that isolation is ignored here, or isolating one group would collapse the
 * table to that group and hide the rows the user isolates from. An isolation
 * any OTHER feature installed still filters, because the list does not own it.
 */

import { useMemo } from 'react';
import type { ListRow } from '@ifc-lite/lists';
import { useViewerStore } from '@/store';
import { getVisibleBasketEntityRefsFromStore } from '@/store/basketVisibleSet';
import { ownsCurrentVisibility } from '@/lib/visibility/ownership';

export function useVisibleListRows(rows: ListRow[], filterByVisibility: boolean): ListRow[] {
  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const classFilter = useViewerStore((s) => s.classFilter);
  const lensHiddenIds = useViewerStore((s) => s.lensHiddenIds);
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
  const typeVisibility = useViewerStore((s) => s.typeVisibility);
  const models = useViewerStore((s) => s.models);
  const activeBasketViewId = useViewerStore((s) => s.activeBasketViewId);
  const geometryResult = useViewerStore((s) => s.geometryResult);
  const listVisibilityOwned = useViewerStore((s) => s.listVisibilityOwned);

  return useMemo(() => {
    if (!filterByVisibility) return rows;
    const ownIsolation = listVisibilityOwned?.channel === 'isolate'
      && ownsCurrentVisibility({ isolatedEntities }, listVisibilityOwned);
    const visibleSet = new Set<string>();
    for (const ref of getVisibleBasketEntityRefsFromStore(ownIsolation)) {
      visibleSet.add(`${ref.modelId}:${ref.expressId}`);
    }
    return rows.filter((row) => {
      const modelId = row.modelId === 'default' ? 'legacy' : row.modelId;
      return visibleSet.has(`${modelId}:${row.entityId}`);
    });
    // The store inputs are read through getVisibleBasketEntityRefsFromStore;
    // they are listed so the filter re-runs when any of them changes.
  }, [
    rows, filterByVisibility, hiddenEntities, isolatedEntities, classFilter, lensHiddenIds,
    selectedStoreys, typeVisibility, models, activeBasketViewId, geometryResult, listVisibilityOwned,
  ]);
}
