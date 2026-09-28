/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { edgeSurvives, isStoreyLikeSpatialTypeName, RelationshipType } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { effectiveMutationRelationships } from '@/sdk/adapters/query-overlay-relations';
import { effectiveContextType } from '@/components/viewer/EntityContextMenu.effective-selection';

/** The selected product's effective storey, including containment and aggregate edits. */
export function effectiveStoreyId(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
  selectedId: number,
): number | undefined {
  const spatial = store.spatialHierarchy;
  if (!spatial) return undefined;
  if (!view?.hasPendingChanges()) return spatial.elementToStorey.get(selectedId);
  if (view.isDeleted(selectedId)) return undefined;

  const overlay = effectiveMutationRelationships(store, view);
  const superseded = (id: number) => view.isDeleted(id) || overlay.supersededSourceIds.has(id);
  const isStorey = (id: number) => !view.isDeleted(id)
    && isStoreyLikeSpatialTypeName(effectiveContextType(store, view, id));
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

  // A part or space inherits its storey through an ancestor. The visited set
  // bounds malformed aggregate cycles; source edges lose to their queued edit.
  const queue = [selectedId];
  const enqueued = new Set<number>([selectedId]);
  let cursor = 0;
  const enqueue = (id: number) => {
    if (!enqueued.has(id)) {
      queue.push(id);
      enqueued.add(id);
    }
  };
  while (cursor < queue.length) {
    const id = queue[cursor++];
    if (view.isDeleted(id)) continue;
    const sourceContainers = store.relationships.inverse.getEdges(id, RelationshipType.ContainsElements)
      .filter((edge) => edgeSurvives(edge, superseded)).map((edge) => edge.target);
    const editedContainers = containmentParents.get(id) ?? [];
    for (const containerId of [...sourceContainers, ...editedContainers]) {
      if (isStorey(containerId)) return containerId;
      if (!view.isDeleted(containerId)) enqueue(containerId);
    }
    const sourceParents = store.relationships.inverse.getEdges(id, RelationshipType.Aggregates)
      .filter((edge) => edgeSurvives(edge, superseded)).map((edge) => edge.target);
    const editedParents = aggregateParents.get(id) ?? [];
    for (const parentId of [...sourceParents, ...editedParents]) enqueue(parentId);
  }
  return undefined;
}
