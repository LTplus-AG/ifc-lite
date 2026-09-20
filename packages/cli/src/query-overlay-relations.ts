/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import {
  effectiveRelationshipEdges,
  resolveEffectiveRelationshipOverlay,
  type IfcDataStore,
} from '@ifc-lite/parser';
import type { EntityData, EntityRef, EntityRelationshipsData } from '@ifc-lite/sdk';

function effective(store: IfcDataStore, view: MutablePropertyView) {
  return resolveEffectiveRelationshipOverlay(store, {
    createdEntities: () => view.getNewEntities(),
    mutatedEntityIds: () => view.getMutations().map(mutation => mutation.entityId),
    namedAttributes: id => view.getAttributeMutationsForEntity(id).map(({ name, value }) => [name, value] as const),
    positionalAttributes: id => view.getPositionalMutationsForEntity(id) ?? [],
    entityType: id => view.getEntityTypeMutation(id)?.newType,
    isDeleted: id => view.isDeleted(id),
  });
}

/** Apply queued relationship creates, endpoint edits and deletes to every
 * relationship projection exposed by the public CLI backend. */
export function foldQueuedRelationshipData(
  store: IfcDataStore,
  view: MutablePropertyView,
  result: EntityRelationshipsData,
  ref: EntityRef,
  entityData: (ref: EntityRef) => EntityData | null,
): EntityRelationshipsData {
  if (view.isDeleted(ref.expressId)) {
    return { voids: [], fills: [], groups: [], connections: [], relations: [] };
  }
  const overlay = effective(store, view);
  const seen = new Set<string>();
  const relations = (result.relations ?? []).flatMap((edge) => {
    if (view.isDeleted(edge.relationshipId) || overlay.supersededSourceIds.has(edge.relationshipId)
      || view.isDeleted(edge.entity.id)) return [];
    const target = entityData({ modelId: ref.modelId, expressId: edge.entity.id });
    if (!target) return [];
    const key = `${edge.direction}:${edge.relationshipId}:${edge.entity.id}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const type = view.getEntityTypeMutation(edge.entity.id)?.newType ?? edge.entity.type;
    return [{ ...edge, entity: { id: edge.entity.id, name: target.name || undefined, type } }];
  });
  for (const edge of effectiveRelationshipEdges(overlay, id => view.isDeleted(id), ref.expressId)) {
    const key = `${edge.direction}:${edge.relationshipId}:${edge.targetId}`;
    if (seen.has(key)) continue;
    const target = entityData({ modelId: ref.modelId, expressId: edge.targetId });
    if (!target) continue;
    seen.add(key);
    relations.push({
      relationshipId: edge.relationshipId,
      relationshipType: edge.relationshipType,
      direction: edge.direction,
      entity: { id: edge.targetId, name: target.name || undefined, type: target.type },
    });
  }
  const entities = (types: readonly string[], directions: readonly ('forward' | 'inverse')[]) => relations
    .filter(edge => types.includes(edge.relationshipType.toUpperCase()) && directions.includes(edge.direction))
    .map(edge => edge.entity);
  return {
    voids: entities(['IFCRELVOIDSELEMENT'], ['forward'])
      .filter((entity, index, all) => all.findIndex(other => other.id === entity.id) === index),
    fills: entities(['IFCRELFILLSELEMENT'], ['inverse'])
      .filter((entity, index, all) => all.findIndex(other => other.id === entity.id) === index),
    groups: entities(['IFCRELASSIGNSTOGROUP', 'IFCRELASSIGNSTOGROUPBYFACTOR'], ['inverse'])
      .filter((entity, index, all) => all.findIndex(other => other.id === entity.id) === index),
    connections: entities(['IFCRELCONNECTSPATHELEMENTS'], ['forward', 'inverse'])
      .filter((entity, index, all) => entity.id !== ref.expressId
        && all.findIndex(other => other.id === entity.id) === index),
    relations,
  };
}

export function foldQueuedRelated(
  store: IfcDataStore,
  view: MutablePropertyView,
  relType: string,
  direction: 'forward' | 'inverse',
  expressId: number,
): number[] {
  return effectiveRelationshipEdges(effective(store, view), id => view.isDeleted(id), expressId, relType)
    .filter(edge => edge.direction === direction)
    .map(edge => edge.targetId);
}

export function supersededRelationshipIds(store: IfcDataStore, view: MutablePropertyView): ReadonlySet<number> {
  return effective(store, view).supersededSourceIds;
}
