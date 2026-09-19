/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityData, EntityRef, EntityRelationshipsData } from '@ifc-lite/sdk';
import { queuedRelationshipEdges, type PendingOverlay } from './overlay.js';

/** Apply queued relationship creates/deletes and endpoint metadata edits. */
export function foldRelationshipRows(
  result: EntityRelationshipsData,
  pending: PendingOverlay,
  ref: EntityRef,
  entityData: (ref: EntityRef) => EntityData | null,
): EntityRelationshipsData {
  if (pending.deleted.has(ref.expressId)) return { ...result, relations: [] };
  const seen = new Set<string>();
  const relations = (result.relations ?? []).flatMap((edge) => {
    if (pending.deleted.has(edge.relationshipId) || pending.deleted.has(edge.entity.id)) return [];
    const target = entityData({ modelId: ref.modelId, expressId: edge.entity.id });
    if (!target) return [];
    const key = `${edge.direction}:${edge.relationshipId}:${edge.entity.id}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...edge, entity: { id: edge.entity.id, name: target.name || undefined, type: target.type } }];
  });
  for (const edge of queuedRelationshipEdges(pending.createdAll, pending.deleted, ref.expressId)) {
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
  return { ...result, relations };
}
