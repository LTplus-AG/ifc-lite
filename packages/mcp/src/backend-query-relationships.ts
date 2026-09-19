/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityData, EntityRef, EntityRelationshipsData } from '@ifc-lite/sdk';
import type { PendingOverlay } from './overlay.js';

/** Apply queued relationship creates/deletes and endpoint metadata edits. */
export function foldRelationshipRows(
  result: EntityRelationshipsData,
  pending: PendingOverlay,
  ref: EntityRef,
  entityData: (ref: EntityRef) => EntityData | null,
): EntityRelationshipsData {
  if (pending.deleted.has(ref.expressId)) {
    return { voids: [], fills: [], groups: [], connections: [], relations: [] };
  }
  const seen = new Set<string>();
  const relations = (result.relations ?? []).flatMap((edge) => {
    if (pending.deleted.has(edge.relationshipId) || pending.supersededRelationshipIds.has(edge.relationshipId)
      || pending.deleted.has(edge.entity.id)) return [];
    const target = entityData({ modelId: ref.modelId, expressId: edge.entity.id });
    if (!target) return [];
    const key = `${edge.direction}:${edge.relationshipId}:${edge.entity.id}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...edge, entity: { id: edge.entity.id, name: target.name || undefined, type: target.type } }];
  });
  for (const edge of pending.relationshipEdges(ref.expressId)) {
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
      .filter((entity, index, all) => all.findIndex(other => other.id === entity.id) === index)
      .map(({ id, name }) => ({ id, name })),
    connections: entities(['IFCRELCONNECTSPATHELEMENTS'], ['forward', 'inverse'])
      .filter((entity, index, all) => entity.id !== ref.expressId && all.findIndex(other => other.id === entity.id) === index),
    relations,
  };
}
