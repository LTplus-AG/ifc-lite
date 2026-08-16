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

/**
 * Does `rootId` — or any of its `IfcRelAggregates` descendants — carry geometry?
 *
 * The 3D-oriented trees (By Class, By Type) drop every entity absent from
 * `geometricIds`, which discards an assembly whose meshes all live on its parts:
 * the assembly is renderable, just not under its own id. This is the predicate
 * that admits exactly that case while still rejecting a container with neither
 * geometry nor geometry-bearing parts (issue #1133 applied beyond the spatial
 * tree).
 *
 * Short-circuits on the first geometry-bearing descendant, is cycle-guarded, and
 * takes an optional `cache` so a whole-model scan stays roughly linear instead
 * of re-walking shared subtrees once per entity. The cache is keyed by express
 * id, so it is only valid for ONE model's relationship graph and one
 * `geometricIds` snapshot — allocate a fresh one per model per tree rebuild.
 */
export function hasAggregatedGeometry(
  relationships: AggregationRelationships | undefined,
  rootId: number,
  toGlobalId: (expressId: number) => number,
  geometricIds: ReadonlySet<number>,
  cache?: Map<number, boolean>,
): boolean {
  const cached = cache?.get(rootId);
  if (cached !== undefined) return cached;
  let result = geometricIds.has(toGlobalId(rootId));
  if (!result && relationships) {
    // Fetch the children BEFORE allocating `seen`/copying them into the walk
    // stack: the overwhelming majority of a whole-model scan (property sets,
    // relationship objects, ordinary elements) decomposes nothing, so this
    // keeps the common miss down to one `getRelated` call and zero
    // allocations, instead of a `Set` + an array copy for every entity in the
    // table. The `.slice()` below is NOT waste: `AggregationRelationships` is
    // a public interface — the production graphs all return a fresh `.map`ped
    // array per call, but nothing guarantees every implementation (or test
    // double) does, and popping directly off a shared/cached array would
    // silently truncate the caller's own adjacency data on the next call.
    const children = relationships.getRelated(rootId, RelationshipType.Aggregates, 'forward');
    if (children.length > 0) {
      const seen = new Set<number>([rootId]);
      const stack = children.slice();
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        // A descendant already decided (as a root, or on an earlier walk) short-
        // circuits the rest of its subtree.
        const sub = cache?.get(id);
        if (sub === true || (sub === undefined && geometricIds.has(toGlobalId(id)))) {
          result = true;
          break;
        }
        if (sub === false) continue;
        for (const kid of relationships.getRelated(id, RelationshipType.Aggregates, 'forward')) {
          if (!seen.has(kid)) stack.push(kid);
        }
      }
    }
  }
  cache?.set(rootId, result);
  return result;
}

/** A globalId-space entity reference, as the viewport and selection layers use. */
export interface AggregationModelAccess {
  /** globalId → the owning model and its model-local express id. */
  resolve(globalId: number): { modelId: string; expressId: number };
  /** The owning model's `IfcRelAggregates` graph, if it has one. */
  relationshipsFor(modelId: string): AggregationRelationships | undefined;
  /** Model-local express id → globalId, for the SAME model (never across). */
  toGlobalId(modelId: string, expressId: number): number;
}

/**
 * Replace every id in `globalIds` that has no renderable geometry with the
 * aggregated parts that do.
 *
 * Framing, like the class trees, asks each selected id for a bounding box and
 * skips it when there is none — so selecting a geometry-less assembly and
 * pressing Frame moved the camera nowhere. Expanding here makes an assembly
 * frame as the union of its parts.
 *
 * Ids that already have geometry pass through untouched and in order. An id
 * with neither geometry nor geometry-bearing parts is dropped, exactly as the
 * caller's own `continue` would have dropped it. Resolution stays inside one
 * model: descendants are mapped back through the SAME model's offset.
 */
export function expandToGeometryBearingIds(
  globalIds: readonly number[],
  hasGeometry: (globalId: number) => boolean,
  access: AggregationModelAccess,
): number[] {
  const out: number[] = [];
  const emitted = new Set<number>();
  const push = (id: number) => {
    if (emitted.has(id)) return;
    emitted.add(id);
    out.push(id);
  };
  for (const globalId of globalIds) {
    if (hasGeometry(globalId)) {
      push(globalId);
      continue;
    }
    const { modelId, expressId } = access.resolve(globalId);
    const relationships = access.relationshipsFor(modelId);
    if (!relationships) continue;
    for (const descendant of collectAggregatedDescendants(relationships, expressId)) {
      const partGlobalId = access.toGlobalId(modelId, descendant);
      if (hasGeometry(partGlobalId)) push(partGlobalId);
    }
  }
  return out;
}
