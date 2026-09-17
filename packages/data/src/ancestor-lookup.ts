/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Upward spatial-ancestor traversal — the `parent=` counterpart to
 * `decomposition.ts`'s downward `IfcRelAggregates` walk.
 *
 * IfcOpenShell's `parent=Foo` selector matches an element that is a direct
 * OR INDIRECT child, in the spatial hierarchy, of an element whose `Name`
 * is `Foo` (docs.ifcopenshell.org/ifcopenshell-python/selector_syntax.html).
 * "Spatial hierarchy" here means both edge kinds a real model actually
 * uses: `IfcRelContainedInSpatialStructure` (an element sitting directly in
 * a storey or space) and `IfcRelAggregates` (a storey aggregated under a
 * building, or a part aggregated under an assembly that itself sits in a
 * storey). Neither alone reaches every ancestor a real file has — a wall
 * inside an `IfcElementAssembly` reaches its storey through one hop of
 * each kind — so this walks both, at any depth.
 *
 * Built once, here, rather than in `apps/viewer` (#4903, following the
 * maintainer's #4094 ruling), so a future CLI/MCP/SDK `parent=` adopts this
 * same traversal instead of re-deriving it — the repeated defect this repo
 * tracks as "one rule, two implementations."
 */

import { RelationshipType } from './relationship-type.js';

/** Structural view of the relationship graph this walk needs — satisfied by
 *  the parser's real `RelationshipGraph` and by a test double alike. */
export interface AncestorRelationships {
  getRelated(
    entityId: number,
    relType: RelationshipType,
    direction: 'forward' | 'inverse',
  ): number[];
}

/**
 * Every ancestor id of `expressId`, walking upward through spatial
 * containment (`IfcRelContainedInSpatialStructure`) and aggregation
 * (`IfcRelAggregates`, which also carries `IfcRelNests` — see
 * {@link RelationshipType.Aggregates}) to any depth. Excludes `expressId`
 * itself. Order is breadth-first by hop distance; a caller that only tests
 * whether some ancestor's Name matches doesn't depend on it.
 *
 * Cycle-safe: a malformed file can have A contain/aggregate B and B
 * contain/aggregate A. A `seen` set means every id is enqueued at most
 * once, so the walk always terminates — with whatever ancestors it found
 * before the cycle closed — rather than looping or growing the queue
 * without bound.
 */
export function collectSpatialAncestors(
  relationships: AncestorRelationships | undefined,
  expressId: number,
): number[] {
  if (!relationships) return [];
  const out: number[] = [];
  const seen = new Set<number>([expressId]);
  const queue: number[] = [expressId];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    const parents = [
      ...relationships.getRelated(id, RelationshipType.ContainsElements, 'inverse'),
      ...relationships.getRelated(id, RelationshipType.Aggregates, 'inverse'),
    ];
    for (const parentId of parents) {
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      out.push(parentId);
      queue.push(parentId);
    }
  }
  return out;
}
