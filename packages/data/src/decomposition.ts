/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcRelAggregates` decomposition traversal.
 *
 * An assembly — `IfcElementAssembly`, an `IfcStair`/`IfcRoof`/`IfcRamp` used
 * as a container, a wall with `IfcBuildingElementPart`s — often carries no
 * mesh of its own; its parts (stair flights, railings, landing slabs, …)
 * hang off it via `IfcRelAggregates`. Any consumer that resolves a selector
 * to a container id and hands that straight to a mesh-keyed sink (a
 * highlight set, a visibility override, a bounding-box lookup) sees nothing,
 * because the container itself is never a key in that sink. This module is
 * the single traversal both `apps/viewer` (which additionally knows which
 * ids actually rendered, and filters to those) and `packages/mcp` (which
 * does not have that live rendering information and instead passes the full
 * decomposition closure through, safe because the mesh-keyed sinks already
 * no-op on ids they never rendered) build their own expansion on top of.
 */

import { RelationshipType } from './types.js';

/** Structural view of the relationship graph — both the parser's
 *  `RelationshipGraph` and a cache-rebuilt or test-double graph satisfy it. */
export interface DecompositionRelationships {
  getRelated(
    entityId: number,
    relType: RelationshipType,
    direction: 'forward' | 'inverse'
  ): number[];
}

/** Direct `IfcRelAggregates` children of `expressId` (one level down). */
export function getAggregatedChildren(
  relationships: DecompositionRelationships | undefined,
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
  relationships: DecompositionRelationships | undefined,
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
