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
import type { ZoneAssignmentsByElement } from '@/lib/zones/types';

export interface ZoneSelectionResolution {
  /** Global ids that matched AND resolved to a loaded model — feeds
   *  `setSelectedEntityIds` (the channel that drives highlight and
   *  frameSelection). */
  globalIds: number[];
  /** The same elements as `globalIds`, as model-aware refs for
   *  `addEntitiesToSelection`. Always the same length as `globalIds`. */
  refs: EntityRef[];
}

/**
 * Pure core of {@link selectElementsInZone}, extracted for unit tests.
 *
 * A matched assignment whose global id no longer resolves to a loaded model
 * (e.g. the model was unloaded between the last assignment recompute and this
 * call) is dropped from BOTH outputs — the two selection channels must never
 * diverge, and the caller's "Selected N element(s)" toast must count what was
 * actually selected (PR #1869 review).
 *
 * `resolve` is supplied by {@link selectElementsInZone}; tests pass their own.
 */
export function resolveZoneSelection(
  zoneAssignments: ZoneAssignmentsByElement,
  setId: string,
  zoneId: string | null,
  resolve: (globalId: number) => { modelId: string; expressId: number } | null | undefined,
): ZoneSelectionResolution {
  const globalIds: number[] = [];
  const refs: EntityRef[] = [];
  for (const [globalId, record] of zoneAssignments) {
    const assignment = record[setId];
    if (!assignment) continue;
    const matches = zoneId === null
      ? assignment.touchedZoneIds.length === 0
      : assignment.zoneId === zoneId || assignment.touchedZoneIds.includes(zoneId);
    if (!matches) continue;
    const lookup = resolve(globalId);
    if (!lookup) continue;
    globalIds.push(globalId);
    refs.push({ modelId: lookup.modelId, expressId: lookup.expressId });
  }
  return { globalIds, refs };
}

/**
 * Select every element assigned to `zoneId` within zone set `setId`.
 * `zoneId: null` selects every element the set's assignment recorded as
 * touching NO zone at all (the "unassigned" bucket) — distinct from an
 * element that straddles multiple zones, which IS included when `zoneId`
 * matches one of its `touchedZoneIds` (so "select zone A" also picks up
 * elements straddling A and B, matching what the Lists `zone` column shows
 * for that row).
 *
 * Returns the number of elements actually selected (matched AND resolved).
 *
 * Resolution goes through the store's canonical `resolveGlobalIdFromModels`
 * (`modelSlice.ts`) — the same resolver `resolveEntityRef.ts` calls "the single
 * source of truth" — and only falls back to the `federationRegistry` singleton
 * (`fromGlobalId`) for a model that has left `state.models` but is still
 * registered. It used to consult the registry ALONE, which made this a silent
 * no-op in a collaborative room: `collabSlice.ts` seeds the room model with
 * `upsertModel` and never calls `registerModelOffset`, so the registry knew
 * none of its ids, every lookup returned `null`, and every matched element was
 * dropped. Federated-IFCX composition (`useIfcFederation.ts`) has the same gap.
 * PR #2697 is the sibling fix for the clash path.
 *
 * The store pass is also the only one that sees overlay-allocated ids (its
 * documented second pass through `mutationViews`), which a plain offset-range
 * check misses.
 */
export function selectElementsInZone(setId: string, zoneId: string | null): number {
  const state = useViewerStore.getState();
  const { globalIds, refs } = resolveZoneSelection(
    state.zoneAssignments,
    setId,
    zoneId,
    (globalId) => state.resolveGlobalIdFromModels(globalId) ?? state.fromGlobalId(globalId),
  );

  state.clearEntitySelection();
  if (globalIds.length === 0) return 0;

  state.setSelectedEntityIds(globalIds);
  state.addEntitiesToSelection(refs);
  return globalIds.length;
}
