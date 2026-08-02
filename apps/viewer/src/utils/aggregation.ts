/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Helpers for IFC decomposition (`IfcRelAggregates`).
 *
 * An assembly — `IfcElementAssembly`, an `IfcStair`/`IfcRoof`/`IfcRamp` used as
 * a container, a wall with `IfcBuildingElementPart`s — carries no geometry of
 * its own; its parts (stair flights, railings, landing slabs, virtual clearance
 * volumes, …) hang off it via `IfcRelAggregates` and hold the actual meshes.
 * The spatial hierarchy only records the assembly as a leaf contained in its
 * storey, so the parts are invisible to anything that walks the tree (the
 * spatial panel, storey isolation, assembly selection). These helpers recover
 * the parts straight from the relationship graph, which both fresh parses and
 * cache loads retain (issue #1133).
 */

import { RelationshipType } from '@ifc-lite/data';

/** Structural view of the relationship graph — both the parser's
 *  `RelationshipGraph` and the cache-rebuilt graph satisfy it. */
export interface AggregationRelationships {
  getRelated(
    entityId: number,
    relType: RelationshipType,
    direction: 'forward' | 'inverse'
  ): number[];
}

/** Direct `IfcRelAggregates` children of `expressId` (one level down). */
export function getAggregatedChildren(
  relationships: AggregationRelationships | undefined,
  expressId: number
): number[] {
  if (!relationships) return [];
  return relationships.getRelated(expressId, RelationshipType.Aggregates, 'forward');
}

/**
 * All decomposition descendants of `rootId` via `IfcRelAggregates`, depth-first
 * and excluding `rootId` itself. Cycle-guarded against malformed files
 * (A aggregates B, B aggregates A) so it always terminates. Order is a stable
 * pre-order so callers can rely on it for display.
 */
export function collectAggregatedDescendants(
  relationships: AggregationRelationships | undefined,
  rootId: number
): number[] {
  if (!relationships) return [];
  const out: number[] = [];
  const seen = new Set<number>([rootId]);
  // DFS with an explicit stack; push children in reverse so siblings keep
  // their authored order in the pre-order output.
  const stack: number[] = [];
  const pushChildren = (parentId: number) => {
    const kids = relationships.getRelated(parentId, RelationshipType.Aggregates, 'forward');
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  };
  pushChildren(rootId);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    pushChildren(id);
  }
  return out;
}
