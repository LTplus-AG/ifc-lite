// SPDX-License-Identifier: MPL-2.0
/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { RelationshipType, isStoreyLikeSpatialTypeName } from '@ifc-lite/data';
import { iterateEffectiveEntityIds, type MutablePropertyView, type NewEntity } from '@ifc-lite/mutations';
import { resolveEffectiveRelationshipOverlay, type IfcDataStore } from '@ifc-lite/parser';

/** Candidate set combines the immutable source domain, indexed authored refs,
 * and sparse slot/type edits. A queued edit can introduce a reference absent
 * from the authored index, or remove one; callers always read effective slots. */
export function* sourceAssociationCandidates(store: IfcDataStore, view: MutablePropertyView | null, id: number, types: readonly string[]) {
  const seen = new Set<number>();
  for (const entity of iterateEffectiveEntityIds(store, null, types)) {
    seen.add(entity.expressId);
    const type = view?.getEntityTypeMutation(entity.expressId)?.newType ?? entity.type;
    if (!view?.isDeleted(entity.expressId) && types.includes(type.toUpperCase())) yield { expressId: entity.expressId, type };
  }
  if (!view) return;
  const candidates = new Set([...view.getNewEntitiesReferencing(id)].map(e => e.expressId));
  for (const entityId of view.getAttributeOverrideEntityIds()) candidates.add(entityId);
  for (const expressId of candidates) {
    if (seen.has(expressId) || view.isDeleted(expressId)) continue;
    const type = view.getEntityTypeMutation(expressId)?.newType ?? view.getNewEntity(expressId)?.type ?? store.getEntity(expressId)?.type;
    if (type && types.includes(type.toUpperCase())) yield { expressId, type };
  }
}

/** Build only the overlay ancestor subgraph needed by effectiveStoreyId.
 * The immutable source graph already indexes its inverse edges. Created
 * relationships use the overlay's maintained reference buckets. */
export function sourceSpatialContext(store: IfcDataStore, view: MutablePropertyView, sourceId: number) {
  const edited = view.getAttributeOverrideEntityIds();
  const created = new Map<number, NewEntity>();
  const reader = {
    createdEntities: () => [...created.values()],
    mutatedEntityIds: () => edited,
    namedAttributes: (id: number) => view.getAttributeMutationsForEntity(id).map(({ name, value }) => [name, value] as const),
    positionalAttributes: (id: number) => view.getPositionalMutationsForEntity(id) ?? [],
    entityType: (id: number) => view.getEntityTypeMutation(id)?.newType,
    isDeleted: (id: number) => view.isDeleted(id),
  };
  // Edited creations are also candidates even if their original refs differ.
  for (const id of edited) { const row = view.getNewEntity(id); if (row) created.set(id, row); }
  const typeName = (id: number) => view.getEntityTypeMutation(id)?.newType ?? view.getNewEntity(id)?.type ?? store.entities.getTypeName(id);
  const queue = [sourceId], visited = new Set(queue);
  let relationships = resolveEffectiveRelationshipOverlay(store, reader);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor];
    let added = false;
    for (const row of view.getNewEntitiesReferencing(id)) {
      if (!row.type.toUpperCase().startsWith('IFCREL') || created.has(row.expressId)) continue;
      created.set(row.expressId, row); added = true;
    }
    if (added) relationships = resolveEffectiveRelationshipOverlay(store, reader);
    const parents = store.relationships.inverse.getEdges(id, RelationshipType.ContainsElements)
      .concat(store.relationships.inverse.getEdges(id, RelationshipType.Aggregates)).map(edge => edge.target);
    for (const rel of relationships.relationships) {
      if (['IFCRELCONTAINEDINSPATIALSTRUCTURE', 'IFCRELAGGREGATES', 'IFCRELNESTS'].includes(rel.relationshipType.toUpperCase()) && rel.related.includes(id)) parents.push(...rel.relating);
    }
    for (const parent of parents) if (!visited.has(parent) && !view.isDeleted(parent) && !isStoreyLikeSpatialTypeName(typeName(parent))) { visited.add(parent); queue.push(parent); }
  }
  return { relationships, isDeleted: reader.isDeleted,
    typeName };
}
