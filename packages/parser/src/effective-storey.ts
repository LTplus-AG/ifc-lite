/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { edgeSurvives, isStoreyLikeSpatialTypeName, RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import type { EffectiveSpatialContext } from './effective-spatial-members.js';
import { normalizeIfcTypeName } from './ifc-schema.js';

/** Resolve a product's containing storey after queued containment and aggregate edits. */
export function effectiveStoreyId(
  store: IfcDataStore,
  expressId: number,
  context?: EffectiveSpatialContext | null,
): number | undefined {
  const spatial = store.spatialHierarchy;
  if (!spatial) return undefined;
  if (!context) return spatial.elementToStorey.get(expressId);
  if (context.isDeleted(expressId)) return undefined;

  const superseded = (id: number) => context.isDeleted(id)
    || context.relationships.supersededSourceIds.has(id);
  const isStorey = (id: number) => !context.isDeleted(id)
    && isStoreyLikeSpatialTypeName(normalizeIfcTypeName(context.typeName(id)));
  const containmentParents = new Map<number, number[]>();
  const aggregateParents = new Map<number, number[]>();
  const append = (map: Map<number, number[]>, key: number, values: readonly number[]) => {
    const row = map.get(key) ?? [];
    row.push(...values);
    map.set(key, row);
  };
  for (const relation of context.relationships.relationships) {
    const type = relation.relationshipType.toUpperCase();
    if (type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE') {
      for (const id of relation.related) append(containmentParents, id, relation.relating);
    } else if (type === 'IFCRELAGGREGATES' || type === 'IFCRELNESTS') {
      for (const id of relation.related) append(aggregateParents, id, relation.relating);
    }
  }

  const queue = [expressId];
  const visited = new Set<number>(queue);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const id = queue[cursor];
    if (context.isDeleted(id)) continue;
    const sourceContainers = store.relationships.inverse.getEdges(id, RelationshipType.ContainsElements)
      .filter((edge) => edgeSurvives(edge, superseded)).map((edge) => edge.target);
    for (const parent of [...sourceContainers, ...(containmentParents.get(id) ?? [])]) {
      if (isStorey(parent)) return parent;
      if (!context.isDeleted(parent) && !visited.has(parent)) {
        visited.add(parent);
        queue.push(parent);
      }
    }
    const sourceParents = store.relationships.inverse.getEdges(id, RelationshipType.Aggregates)
      .filter((edge) => edgeSurvives(edge, superseded)).map((edge) => edge.target);
    for (const parent of [...sourceParents, ...(aggregateParents.get(id) ?? [])]) {
      // A spatial child a storey aggregates (IfcSpace, IfcSpatialZone) is on
      // that storey — the rule `elementToStorey` applies to the parsed model
      // (#1075), which this edited-model path must agree with.
      if (isStorey(parent) && !isStorey(id)) return parent;
      if (!context.isDeleted(parent) && !visited.has(parent)) {
        visited.add(parent);
        queue.push(parent);
      }
    }
  }
  return undefined;
}
