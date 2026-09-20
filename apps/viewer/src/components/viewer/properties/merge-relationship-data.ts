/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityRef, EntityRelationshipsData } from '@ifc-lite/sdk';

type RelatedEntity = EntityRelationshipsData['connections'][number];

function uniqueEntities<T extends { id: number }>(...groups: readonly (readonly T[])[]): T[] {
  const seen = new Set<number>();
  return groups.flatMap(group => group.filter(entity => {
    if (seen.has(entity.id)) return false;
    seen.add(entity.id);
    return true;
  }));
}

/** Combine inherited source relationships with edges authored on a duplicate. */
export function mergeRelationshipData(
  inherited: EntityRelationshipsData,
  direct: EntityRelationshipsData,
): EntityRelationshipsData {
  const seenRelations = new Set<string>();
  const relations = [...(inherited.relations ?? []), ...(direct.relations ?? [])].filter(edge => {
    const key = `${edge.direction}:${edge.relationshipId}:${edge.entity.id}`;
    if (seenRelations.has(key)) return false;
    seenRelations.add(key);
    return true;
  });
  return {
    voids: uniqueEntities(inherited.voids, direct.voids),
    fills: uniqueEntities(inherited.fills, direct.fills),
    groups: uniqueEntities(inherited.groups, direct.groups),
    connections: uniqueEntities(inherited.connections, direct.connections),
    relations,
  };
}

export function relationshipsForSelection(
  getRelationships: (ref: EntityRef) => EntityRelationshipsData,
  selected: EntityRef,
  lookupExpressId: number,
): EntityRelationshipsData {
  const inherited = getRelationships({ modelId: selected.modelId, expressId: lookupExpressId });
  return lookupExpressId === selected.expressId
    ? inherited
    : mergeRelationshipData(inherited, getRelationships(selected));
}

/** Resolve the effective members of a group, including queued relationship edits. */
export function groupMembersForRef(
  getRelationships: (ref: EntityRef) => EntityRelationshipsData,
  group: EntityRef,
): RelatedEntity[] {
  const seen = new Set<number>();
  return (getRelationships(group).relations ?? []).flatMap((edge) => {
    const groupAssignment = edge.direction === 'forward'
      && ['IFCRELASSIGNSTOGROUP', 'IFCRELASSIGNSTOGROUPBYFACTOR'].includes(edge.relationshipType.toUpperCase());
    if (!groupAssignment || seen.has(edge.entity.id)) return [];
    seen.add(edge.entity.id);
    return [edge.entity];
  });
}
