/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "How many objects?" — the single rule every user-facing count labelled
 * *objects* or *elements* answers.
 *
 * An object is a **physical element that has a shape**. Two independent tests,
 * neither sufficient on its own:
 *
 * 1. **Schema** — `isPhysicalObjectType` (`lib/physical-objects.ts`): the
 *    inheritance chain contains `IfcElement`, minus `IfcFeatureElement` and
 *    `IfcVirtualElement`. This is what rejects `IfcGroup`, `IfcZone`,
 *    `IfcSystem`, the spatial chain, `IfcSpace`, `IfcGrid` and `IfcAnnotation`.
 * 2. **Shape** — the entity produced a mesh, or it decomposes via
 *    `IfcRelAggregates` into a part that did (`hasAggregatedGeometry`). This is
 *    what rejects an element carrying a placement and `Representation = $`: it
 *    cannot be seen, isolated, measured, sectioned or exported to any mesh
 *    format, so it must not inflate a number a user reads as "objects".
 *
 * Neither test substitutes for the other. `IfcAnnotation` carries a
 * representation and so passes the shape test while failing the schema test; an
 * `IfcRoof` used as a pure assembly container passes the schema test and has no
 * representation of its own, which is why the shape test descends the
 * aggregation graph instead of reading the entity's own slot.
 *
 * `IfcBuildingElementProxy` is never excluded as a class — real exports lean on
 * it heavily and most proxies do carry geometry. The discriminator is *has a
 * shape*, never the class alone, and never the entity's Name.
 *
 * ## Ids are model-local
 *
 * Everything here works in ONE model's express-id space: the mesh id set, the
 * relationship graph and the type lookup all come from the same
 * `IfcDataStore`. Federated callers build one {@link ObjectCountModel} per
 * model and add the per-model answers up, which is both simpler and cheaper
 * than routing every id through the global-id mapping.
 *
 * ## Before geometry exists
 *
 * While a model is still streaming, no mesh may have landed and `meshedIds`
 * can be empty. Applying the shape test then would report zero objects for a
 * model that plainly has them, so a missing geometry result disables the shape
 * test and the schema test stands alone — the same "filter is a no-op until
 * geometry exists" contract the hierarchy trees use. Once geometry processing
 * has completed, an empty set is authoritative and correctly reports zero.
 */

import { isPhysicalObjectType } from './physical-objects.js';
import { hasAggregatedGeometry, type AggregationRelationships } from '@/utils/aggregation.js';

/** What the shape test alone needs from one model. */
export interface ShapeSource {
  /** The model's `IfcRelAggregates` graph, for the assembly case. */
  relationships?: AggregationRelationships;
  /** Model-local express ids that produced at least one mesh. */
  meshedIds: ReadonlySet<number>;
  /** Whether geometry processing has produced a result, including a known-empty one. */
  geometryReady?: boolean;
}

/** One model's view of the facts the whole object rule needs. */
export interface ObjectCountModel extends ShapeSource {
  /** Model-local express id → STEP type name (uppercase or PascalCase). */
  getTypeName: (expressId: number) => string | undefined;
}

/**
 * The SHAPE half on its own: `expressId → does this render?`
 *
 * Split out because a caller that already has a set of ids known to pass the
 * schema test — `collectPhysicalEntityIds`, which derives them from
 * `entityIndex.byType` — would otherwise pay a type lookup per id per call to
 * re-establish what it already knows. Callers holding arbitrary ids want
 * {@link createObjectPredicate} instead; this one answers "does it render",
 * not "is it an object", and says yes to an annotation.
 *
 * The aggregation walk is shared across every call through one cache, so a
 * whole-model scan stays roughly linear rather than re-walking shared subtrees.
 * The cache is only valid for the `meshedIds` snapshot handed in — build a
 * fresh predicate when geometry changes.
 */
export function createShapePredicate(model: ShapeSource): (expressId: number) => boolean {
  const { relationships, meshedIds } = model;
  // No geometry has arrived yet — see "Before geometry exists" above. An
  // explicitly ready result with zero shapes is known-empty, not provisional.
  const applyShapeTest = model.geometryReady ?? meshedIds.size > 0;
  const shapeCache = new Map<number, boolean>();
  const identity = (expressId: number) => expressId;

  return (expressId: number): boolean => {
    if (!applyShapeTest) return true;
    if (meshedIds.has(expressId)) return true;
    return hasAggregatedGeometry(relationships, expressId, identity, meshedIds, shapeCache);
  };
}

/**
 * A memoised `expressId → is this an object?` predicate for one model: the
 * schema test and the shape test, in that order.
 */
export function createObjectPredicate(model: ObjectCountModel): (expressId: number) => boolean {
  const getTypeName = model.getTypeName;
  const hasShape = createShapePredicate(model);

  return (expressId: number): boolean => {
    const typeName = getTypeName(expressId);
    if (!typeName || !isPhysicalObjectType(typeName)) return false;
    return hasShape(expressId);
  };
}

/** How many of `physicalIds` — ids already known to pass the schema test —
 *  have a shape. */
export function countShapedObjects(
  physicalIds: Iterable<number>,
  model: ShapeSource,
): number {
  const hasShape = createShapePredicate(model);
  let count = 0;
  for (const id of physicalIds) {
    if (hasShape(id)) count++;
  }
  return count;
}

/** How many of `expressIds` are objects, under one model's facts. */
export function countObjects(expressIds: Iterable<number>, model: ObjectCountModel): number {
  const isObject = createObjectPredicate(model);
  let count = 0;
  for (const id of expressIds) {
    if (isObject(id)) count++;
  }
  return count;
}

/** Geometry-bearing express ids, including entities rendered only through GPU instancing. */
export function collectMeshedIds(
  geometryResult: {
    meshes?: readonly { expressId: number }[];
    instancedGeometryHashes?: ReadonlyMap<number, unknown>;
    instancedGeometryAabbs?: ReadonlyMap<number, unknown>;
    instancedGeometryVolumes?: ReadonlyMap<number, unknown>;
  } | null | undefined,
  toLocalId: (id: number) => number = (id) => id,
): Set<number> {
  const ids = new Set<number>();
  for (const mesh of geometryResult?.meshes ?? []) ids.add(toLocalId(mesh.expressId));
  for (const map of [
    geometryResult?.instancedGeometryHashes,
    geometryResult?.instancedGeometryAabbs,
    geometryResult?.instancedGeometryVolumes,
  ]) {
    for (const id of map?.keys() ?? []) ids.add(toLocalId(id));
  }
  return ids;
}
