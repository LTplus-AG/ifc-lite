/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Canonical-parent resolution for `SpatialHierarchyBuilder` (split out to stay
 * under the module-size budget, #4095).
 */

import type { EntityTable, RelationshipGraph } from '@ifc-lite/data';
import { IfcTypeEnum, RelationshipType, isSpatialStructureType } from '@ifc-lite/data';

/**
 * Resolve each spatial-structure entity's ONE canonical parent, globally,
 * before any recursion starts - so the result cannot depend on traversal
 * order. Mirrors apps/server's `canonical_parent` (`spatial.rs`, #3973):
 *
 *  1. IfcRelAggregates always wins over mere containment. A child aggregated
 *     by more than one parent (a malformed file) resolves to the LOWEST
 *     `IfcRelAggregates` express id - a deterministic proxy for "first
 *     declared in the file", since a STEP writer emits `IfcRel*` instances in
 *     ascending express-id order in every corpus fixture this repo has seen.
 *  2. Only when a child has NO aggregates edge at all does a containment edge
 *     (IfcRelContainedInSpatialStructure targeting a spatial-structure type -
 *     the Revit Family/Dynamo `IfcSpace`/`IfcSpatialZone` pattern, #1075)
 *     get to claim it, with the same lowest-express-id tie-break.
 *
 * `SpatialHierarchyBuilder.buildNode`'s `addSpatialChild` then only recurses
 * into a child from its canonical parent - every other parent that also
 * names the child drops the edge instead of adding an empty-stub duplicate
 * (#4095).
 */
export function computeCanonicalParent(entities: EntityTable, relationships: RelationshipGraph): Map<number, number> {
  const canonicalParent = new Map<number, number>();

  const claimLowestRelId = (
    predicate: (childId: number) => boolean,
    relType: RelationshipType,
  ): void => {
    for (const childId of relationships.inverse.offsets.keys()) {
      if (canonicalParent.has(childId) || !predicate(childId)) continue;
      const edges = relationships.inverse.getEdges(childId, relType);
      if (edges.length === 0) continue;
      let winner = edges[0];
      for (const edge of edges) {
        if (edge.relationshipId < winner.relationshipId) winner = edge;
      }
      // Inverse edges flip source/target, so `target` here is the original
      // relationship's `relating_id` (the parent).
      canonicalParent.set(childId, winner.target);
    }
  };

  // Pass 1: aggregation, unconditionally - it always wins.
  claimLowestRelId(() => true, RelationshipType.Aggregates);
  // Pass 2: promotion-by-containment, only for children aggregation left unclaimed.
  claimLowestRelId(
    (childId) => {
      const childType = entities.getTypeEnum(childId);
      return isSpatialStructureType(childType) && childType !== IfcTypeEnum.IfcProject;
    },
    RelationshipType.ContainsElements,
  );

  return canonicalParent;
}
