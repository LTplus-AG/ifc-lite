/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Select elements in zone X" (issue #1810). Reads the last-computed
 * `zoneAssignments` (recomputed by `useZoneAssignmentSync`) and drives BOTH
 * selection channels the same way every other multi-model selection entry
 * point does (`ListResultsTable`, `useEntityListMultiSelect`): the
 * renderer-highlight global-id set (`setSelectedEntityIds`) plus the
 * model-aware ref set (`addEntitiesToSelection`), after clearing whatever
 * was selected before.
 *
 * Not a React hook (no component state) — a plain function reading/writing
 * the store directly, same shape as `recomputeZoneAssignmentsNow` in
 * `useZoneAssignmentSync.ts`.
 */

import { useViewerStore } from '@/store';
import type { EntityRef } from '@/store/types';

/**
 * Select every element assigned to `zoneId` within zone set `setId`.
 * `zoneId: null` selects every element the set's assignment recorded as
 * touching NO zone at all (the "unassigned" bucket) — distinct from an
 * element that straddles multiple zones, which IS included when `zoneId`
 * matches one of its `touchedZoneIds` (so "select zone A" also picks up
 * elements straddling A and B, matching what the Lists `zone` column shows
 * for that row).
 *
 * Returns the number of elements selected.
 */
export function selectElementsInZone(setId: string, zoneId: string | null): number {
  const state = useViewerStore.getState();
  const globalIds: number[] = [];
  for (const [globalId, record] of state.zoneAssignments) {
    const assignment = record[setId];
    if (!assignment) continue;
    const matches = zoneId === null
      ? assignment.touchedZoneIds.length === 0
      : assignment.zoneId === zoneId || assignment.touchedZoneIds.includes(zoneId);
    if (matches) globalIds.push(globalId);
  }

  state.clearEntitySelection();
  if (globalIds.length === 0) return 0;

  const refs: EntityRef[] = [];
  for (const globalId of globalIds) {
    const lookup = state.fromGlobalId(globalId);
    if (lookup) refs.push({ modelId: lookup.modelId, expressId: lookup.expressId });
  }

  state.setSelectedEntityIds(globalIds);
  state.addEntitiesToSelection(refs);
  return globalIds.length;
}
