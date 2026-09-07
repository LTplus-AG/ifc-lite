/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type IfcDataStore } from '@ifc-lite/parser';
import { RelationshipType } from '@ifc-lite/data';

import type { PartOfRelation, ParentInfo } from '../types.js';

// Map IDS PartOf relations to the numeric RelationshipType enum the
// graph keys on. Passing strings here was a long-standing silent bug:
// `getRelated` matched nothing → every partOf check looked like
// "no parent" → fail-when-required, pass-when-prohibited.
//
// Each relation maps to a LIST of edge types the ancestor walk follows.
// All but the merged voids/fills token map to a single type; the IDS XSD
// merged voids + fills into one enumeration value
// (`IFCRELVOIDSELEMENT IFCRELFILLSELEMENT`) that links an element to its
// host building element through an opening — a window fills an opening
// (`FillsElement`) that voids a wall (`VoidsElement`). Walking both edge
// types inverse-direction reaches the opening and the wall in turn.
const PARTOF_REL_MAP: Record<PartOfRelation, readonly RelationshipType[]> = {
  IfcRelAggregates: [RelationshipType.Aggregates],
  IfcRelAssignsToGroup: [RelationshipType.AssignsToGroup],
  IfcRelContainedInSpatialStructure: [RelationshipType.ContainsElements],
  IfcRelNests: [RelationshipType.Aggregates],
  IfcRelVoidsElement: [RelationshipType.VoidsElement],
  IfcRelFillsElement: [RelationshipType.FillsElement],
  'IfcRelVoidsElement IfcRelFillsElement': [
    RelationshipType.VoidsElement,
    RelationshipType.FillsElement,
  ],
};

/**
 * BFS walk of the partOf ancestor graph for `expressId`, following the
 * edge type(s) `relationType` maps to. IDS partOf is transitive, so any
 * reachable ancestor counts; the merged voids/fills relation walks two
 * edge types per node, so the queue follows each mapped type in turn.
 *
 * The three type/name resolvers are passed in rather than closed over so
 * this can run standalone from the accessor's own method table (which is
 * how `IFCDataAccessor.getAncestors` calls it).
 */
export function resolvePartOfAncestors(
  store: IfcDataStore,
  expressId: number,
  relationType: PartOfRelation,
  getEntityType: (expressId: number) => string | undefined,
  getPredefinedTypeRaw: (expressId: number) => string | undefined,
  getObjectType: (expressId: number) => string | undefined
): ParentInfo[] {
  const relationships = store.relationships;
  if (!relationships?.getRelated) return [];
  const relTypes = PARTOF_REL_MAP[relationType];
  if (!relTypes || relTypes.length === 0) return [];

  const out: ParentInfo[] = [];
  const seen = new Set<number>([expressId]);
  const queue = [expressId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const relType of relTypes) {
      const parents = relationships.getRelated(id, relType, 'inverse');
      for (const parentId of parents || []) {
        if (seen.has(parentId)) continue;
        seen.add(parentId);
        out.push({
          expressId: parentId,
          entityType: getEntityType(parentId) || 'Unknown',
          // Raw enum token first (BEAM, USERDEFINED, …) — NOT
          // getObjectType. getObjectType collapses USERDEFINED to the
          // accompanying user-defined name, which loses the literal
          // "USERDEFINED" token a spec may legitimately ask for (the
          // same case entity-facet.ts's rawType branch accepts for a
          // direct entity check). The user-defined name is carried
          // separately in `objectType` as a fallback for partof-facet.
          predefinedType: getPredefinedTypeRaw(parentId),
          objectType: getObjectType(parentId),
        });
        queue.push(parentId);
      }
    }
  }
  return out;
}
