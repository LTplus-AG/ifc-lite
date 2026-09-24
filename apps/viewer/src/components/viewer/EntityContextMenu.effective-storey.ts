/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { edgeSurvives, isSpatialStructureTypeName, isStoreyLikeSpatialTypeName, RelationshipType } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { effectiveMutationRelationships } from '@/sdk/adapters/query-overlay-relations';
import { effectiveContextType } from './EntityContextMenu.effective-selection.js';

/** Direct members of the selected element's effective storey. The parser's
 * byStorey list is direct containment, while elementToStorey can also locate
 * an aggregated part or spatial child. Preserve that distinction (#5249). */
export function sameEffectiveStoreyIds(
  store: IfcDataStore,
  view: MutablePropertyView | null,
  selectedId: number,
): number[] {
  const spatial = store.spatialHierarchy;
  if (!spatial) return [];
  if (!view?.hasPendingChanges()) {
    const storeyId = spatial.elementToStorey.get(selectedId);
    return storeyId === undefined ? [] : spatial.byStorey.get(storeyId) ?? [];
  }
  if (view.isDeleted(selectedId)) return [];

  const overlay = effectiveMutationRelationships(store, view);
  const superseded = (id: number) => view.isDeleted(id) || overlay.supersededSourceIds.has(id);
  const isStorey = (id: number) => !view.isDeleted(id)
    && isStoreyLikeSpatialTypeName(effectiveContextType(store, view, id))
    && (spatial.byStorey.has(id) || Boolean(view.getNewEntity(id)));
  const containmentParents = new Map<number, number[]>();
  const aggregateParents = new Map<number, number[]>();
  const append = (map: Map<number, number[]>, key: number, values: readonly number[]) => {
    const row = map.get(key) ?? [];
    for (const value of values) row.push(value);
    map.set(key, row);
  };
  for (const relation of overlay.relationships) {
    const type = relation.relationshipType.toUpperCase();
    if (type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE') {
      for (const id of relation.related) append(containmentParents, id, relation.relating);
    } else if (type === 'IFCRELAGGREGATES' || type === 'IFCRELNESTS') {
      for (const id of relation.related) append(aggregateParents, id, relation.relating);
    }
  }

  // Follow effective containment and aggregation upwards. A part or space can
  // inherit its storey from an ancestor while the selected rows stay direct
  // members. The visited set bounds malformed aggregate cycles.
  const queue = [selectedId];
  const enqueued = new Set<number>([selectedId]);
  let cursor = 0;
  const enqueue = (id: number) => {
    if (!enqueued.has(id)) {
      queue.push(id);
      enqueued.add(id);
    }
  };
  let storeyId: number | undefined;
  while (cursor < queue.length && storeyId === undefined) {
    const id = queue[cursor++];
    if (view.isDeleted(id)) continue;
    const sourceContainers = store.relationships.inverse.getEdges(id, RelationshipType.ContainsElements)
      .filter((edge) => edgeSurvives(edge, superseded)).map((edge) => edge.target);
    const editedContainers = containmentParents.get(id) ?? [];
    for (const containerId of [...sourceContainers, ...editedContainers]) {
      if (isStorey(containerId)) { storeyId = containerId; break; }
      if (!view.isDeleted(containerId)) enqueue(containerId);
    }
    if (storeyId !== undefined) break;
    const sourceParents = store.relationships.inverse.getEdges(id, RelationshipType.Aggregates)
      .filter((edge) => edgeSurvives(edge, superseded)).map((edge) => edge.target);
    const editedParents = aggregateParents.get(id) ?? [];
    for (const parentId of [...sourceParents, ...editedParents]) enqueue(parentId);
  }
  if (storeyId === undefined) return [];

  return effectiveStoreyMemberIds(store, view, storeyId);
}

/** Direct members of a storey after relationship edits, tombstones and creates. */
export function effectiveStoreyMemberIds(
  store: IfcDataStore,
  view: MutablePropertyView | null,
  storeyId: number,
): number[] {
  const spatial = store.spatialHierarchy;
  if (!spatial || view?.isDeleted(storeyId)) return [];
  if (!view?.hasPendingChanges()) return spatial.byStorey.get(storeyId) ?? [];
  const overlay = effectiveMutationRelationships(store, view);
  const superseded = (id: number) => view.isDeleted(id) || overlay.supersededSourceIds.has(id);
  const sourceMembers = store.relationships.forward.getEdges(storeyId, RelationshipType.ContainsElements)
    .filter((edge) => edgeSurvives(edge, superseded)).map((edge) => edge.target);
  const editedMembers = overlay.relationships
    .filter((relation) => relation.relationshipType.toUpperCase() === 'IFCRELCONTAINEDINSPATIALSTRUCTURE'
      && relation.relating.includes(storeyId))
    .flatMap((relation) => relation.related);
  const isSpatial = (id: number) => isSpatialStructureTypeName(effectiveContextType(store, view, id));
  return [...new Set([...sourceMembers, ...editedMembers])]
    .filter((id) => !view.isDeleted(id) && !isSpatial(id));
}
