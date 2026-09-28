/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { edgeSurvives, isSpatialStructureTypeName, RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import type { EffectiveRelationshipOverlay } from './effective-relationship-overlay.js';
import { normalizeIfcTypeName } from './ifc-schema.js';

export interface EffectiveSpatialContext {
  relationships: EffectiveRelationshipOverlay;
  isDeleted(expressId: number): boolean;
  typeName(expressId: number): string;
}

/** Direct non-spatial members of one container, in source-edge then queued-edge order.
 * The parsed hierarchy remains the fast path for a session without edits. */
export function effectiveSpatialMemberIds(
  store: IfcDataStore,
  containerId: number,
  context?: EffectiveSpatialContext | null,
): number[] {
  const hierarchy = store.spatialHierarchy;
  if (!hierarchy || context?.isDeleted(containerId)) return [];
  if (!context) {
    return hierarchy.byStorey.get(containerId)
      ?? hierarchy.byBuilding.get(containerId)
      ?? hierarchy.bySite.get(containerId)
      ?? hierarchy.bySpace.get(containerId)
      ?? [];
  }

  const superseded = (id: number) => context.isDeleted(id)
    || context.relationships.supersededSourceIds.has(id);
  const source = store.relationships.forward.getEdges(containerId, RelationshipType.ContainsElements)
    .filter((edge) => edgeSurvives(edge, superseded))
    .map((edge) => edge.target);
  const queued = context.relationships.relationships
    .filter((relation) => relation.relationshipType.toUpperCase() === 'IFCRELCONTAINEDINSPATIALSTRUCTURE'
      && relation.relating.includes(containerId))
    .flatMap((relation) => relation.related);
  return [...new Set([...source, ...queued])]
    .filter((id) => !context.isDeleted(id)
      && !isSpatialStructureTypeName(normalizeIfcTypeName(context.typeName(id))));
}
