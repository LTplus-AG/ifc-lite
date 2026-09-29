/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace's storey context in 3D (charter #6232, decision D9):
 * which elements sit above the session storey, and how they fold into the
 * hidden / ghost sets the renderer already takes.
 *
 * Derived, never stored. Nothing here writes `hiddenEntities`,
 * `isolatedEntities` or `ghostExceptEntities`: those channels are shared by a
 * dozen features with ownership records (see `visibilitySlice`), and a copy
 * written on entry and restored on exit would drop every change the user made
 * in between. Instead the context is layered on top of the user's own sets at
 * the one place the viewport reads them (`useVisibilityState`), so:
 *
 *   - leaving the workspace, or picking "Show all", is the user's view exactly;
 *   - isolation, Solo, the class filter and the section cut still apply, since
 *     they are separate renderer inputs that this does not touch;
 *   - a storey switch is a new hidden set, not new geometry: the renderer's
 *     hide filter draws the subset of the batches it already holds.
 *
 * An explicit Solo (`selectedStoreys`) wins: it is a stronger storey context the
 * user picked, and hiding "above" on top of it could only hide the soloed storey.
 */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { ViewerState } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { collectIfcBuildingStoreyElementsWithIfcSpace } from '@/store/basketVisibleSet';
import { effectiveScheduleGroups } from '@/lib/effective-spatial-groups';
import { modelStoreys } from '@/lib/commands/modeling/workspace-storeys';
import type { AggregationRelationships } from '@/utils/aggregation';
import type { StoreyContextMode } from '@/store/slices/storeyContextSlice';

export type StoreyContextState = Pick<ViewerState,
  'workspaceMode' | 'session' | 'storeyContextMode' | 'selectedStoreys' | 'models' | 'mutationViews'>;

/**
 * The elements on each storey in the live session (model-local ids), spaces
 * and the parts of aggregates included. An unedited model reads the parsed
 * tree; an edited one reads the current relationships, so an element moved to
 * another storey, deleted, or drawn this session lands where it is now.
 */
export function liveStoreyMembers(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
  storeyIds: readonly number[],
): Map<number, readonly number[]> {
  const out = new Map<number, readonly number[]>();
  if (view?.hasPendingChanges()) {
    const groups = effectiveScheduleGroups(store, view, 'IfcBuildingStorey', { includeSpatialNodes: true });
    for (const id of storeyIds) out.set(id, groups.get(id) ?? []);
    return out;
  }
  const hierarchy = store.spatialHierarchy;
  if (!hierarchy) return out;
  const relationships = store.relationships as AggregationRelationships | undefined;
  for (const id of storeyIds) out.set(id, collectIfcBuildingStoreyElementsWithIfcSpace(hierarchy, id, relationships) ?? []);
  return out;
}

/**
 * Global ids of every element on a storey of the session model whose live
 * elevation is above the session storey's, or `null` when the context is off
 * (outside the workspace, "Show all", Solo active, no storey).
 */
export function storeyContextAboveIds(s: StoreyContextState): Set<number> | null {
  const session = s.session;
  if (s.workspaceMode !== 'model' || !session || session.storeyId === null) return null;
  if (s.storeyContextMode === 'all' || s.selectedStoreys.size > 0) return null;
  const store = s.models.get(session.modelId)?.ifcDataStore;
  if (!store) return null;
  const storeys = modelStoreys(s, session.modelId);
  const active = storeys.find((storey) => storey.expressId === session.storeyId);
  if (!active) return null;
  const above = storeys.filter((storey) => storey.elevation > active.elevation).map((storey) => storey.expressId);
  const ids = new Set<number>();
  for (const members of liveStoreyMembers(store, s.mutationViews.get(session.modelId), above).values()) {
    for (const id of members) ids.add(toGlobalIdFromModels(s.models, session.modelId, id));
  }
  return ids;
}

/** Every entity the loaded models draw, in global ids (flat meshes and GPU instances). */
export function drawableEntityIds(models: ViewerState['models']): Set<number> {
  const ids = new Set<number>();
  for (const model of models.values()) {
    const geometry = model.geometryResult;
    for (const mesh of geometry?.meshes ?? []) {
      if (mesh.entityIds?.length) for (const id of mesh.entityIds) ids.add(id);
      else ids.add(mesh.expressId);
    }
    for (const id of geometry?.instancedGeometryHashes?.keys() ?? []) ids.add(id);
    for (const id of geometry?.instancedGeometryAabbs?.keys() ?? []) ids.add(id);
  }
  return ids;
}

export interface ViewportVisibilitySets {
  hidden: Set<number>;
  ghostExcept: Set<number> | null;
}

/**
 * Fold the storey context into the user's hidden / ghost sets. The inputs are
 * never mutated; with no context (or nothing above) they come back as is.
 *
 * Ghosting rides `ghostExceptIds` (everything NOT in the set fades) because
 * that is the X-Ray input which also reaches GPU-instanced occurrences; the
 * per-id alpha map does not. So "ghost above" is the user's own except-set, or
 * every drawn entity when they have none, minus the elements above.
 */
export function applyStoreyContext(
  user: ViewportVisibilitySets,
  mode: StoreyContextMode,
  above: ReadonlySet<number> | null,
  drawable: () => Iterable<number>,
): ViewportVisibilitySets {
  if (!above || above.size === 0 || mode === 'all') return user;
  if (mode === 'hide') {
    const hidden = new Set(user.hidden);
    for (const id of above) hidden.add(id);
    return { hidden, ghostExcept: user.ghostExcept };
  }
  const ghostExcept = new Set<number>();
  for (const id of user.ghostExcept ?? drawable()) if (!above.has(id)) ghostExcept.add(id);
  return { hidden: user.hidden, ghostExcept };
}
