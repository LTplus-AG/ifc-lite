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

const meshedIdsByResult = new WeakMap<object, ReadonlySet<number>>();

/**
 * `collectMeshedIds(result)` in the result's own id space, scanned once per
 * geometry result object and shared: the hierarchy's selector and its
 * geometric-id set both read it in the commit that publishes a model (NEW-4).
 * Read-only by type: every consumer shares this one set.
 */
export function sharedMeshedIds(result: Parameters<typeof collectMeshedIds>[0] & object): ReadonlySet<number> {
  let ids = meshedIdsByResult.get(result);
  if (!ids) meshedIdsByResult.set(result, ids = collectMeshedIds(result));
  return ids;
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


/** The model ids that address a single, legacy store with no federation offset. */
const LEGACY_IDS = new Set(['legacy', 'default', '__legacy__']);

/** The two store resolvers the canonical mapping combines. */
export interface ModelIdResolvers {
  /** Model-scoped: parse range, then this model's overlay ids (`resolveGlobalIdInModel`). */
  resolveGlobalIdInModel: (modelId: string, id: number) => { expressId: number } | null | undefined;
  /** Federation registry (`fromGlobalId`), for a model the store's model map does not hold. */
  fromGlobalId: (id: number) => { modelId: string; expressId: number } | null | undefined;
}

/**
 * The canonical renderer-id -> model-local-id mapping for a model's own geometry,
 * shared by every whole-model count so they cannot disagree: the model-scoped
 * resolver (which also knows overlay-created ids), then the federation registry
 * restricted to this model. Only the legacy single-store ids fall back to the
 * id itself when neither resolves (a store with no federation entry); a
 * federated model that happens to be called `default` still resolves its offset.
 * Undefined when the id is not this model's.
 */
export function modelLocalIdResolver(modelId: string, resolvers: ModelIdResolvers): (id: number) => number | undefined {
  const identityFallback = LEGACY_IDS.has(modelId);
  return (id) => {
    const scoped = resolvers.resolveGlobalIdInModel(modelId, id);
    if (scoped) return scoped.expressId;
    const ref = resolvers.fromGlobalId(id);
    if (ref) return ref.modelId === modelId ? ref.expressId : undefined;
    return identityFallback ? id : undefined;
  };
}

const modelMeshedIds = new WeakMap<object, Map<string, ReadonlySet<number>>>();

/** A model's meshed ids in its own id space, built once per geometry result. */
export function sharedModelMeshedIds(
  modelId: string,
  geometryResult: Parameters<typeof collectMeshedIds>[0],
  toLocalId: (id: number) => number | undefined,
): ReadonlySet<number> {
  if (!geometryResult) return EMPTY_IDS;
  let byModel = modelMeshedIds.get(geometryResult);
  if (!byModel) modelMeshedIds.set(geometryResult, byModel = new Map());
  let ids = byModel.get(modelId);
  if (!ids) {
    const local = new Set<number>();
    for (const id of sharedMeshedIds(geometryResult)) {
      const localId = toLocalId(id);
      if (localId !== undefined) local.add(localId);
    }
    byModel.set(modelId, ids = local);
  }
  return ids;
}
const EMPTY_IDS: ReadonlySet<number> = new Set();

/** Inputs of {@link sharedShapedObjectCount}: one model's effective physical ids and its geometry. */
export interface SharedShapedCountInput {
  /** Which model the geometry and ids belong to. */
  modelId: string;
  /** `sharedEffectivePhysicalEntityIds(store, view, version)`: its identity stands for all three. */
  physicalIds: ReadonlySet<number>;
  geometryResult: Parameters<typeof collectMeshedIds>[0];
  geometryReady: boolean;
  relationships?: AggregationRelationships;
  /** From {@link modelLocalIdResolver}. */
  toLocalId: (id: number) => number | undefined;
}

const shapedCounts = new WeakMap<ReadonlySet<number>, Map<string, { geometryResult: unknown; geometryReady: boolean; count: number }>>();

/**
 * The number of a model's physical objects that have a shape: the one walk
 * behind the status bar's element count and the model metadata panel's
 * "Elements with Geometry". Both read it through this memo, so a settled model
 * pays for the walk once, not once per consumer.
 */
export function sharedShapedObjectCount(input: SharedShapedCountInput): number {
  let byModel = shapedCounts.get(input.physicalIds);
  if (!byModel) shapedCounts.set(input.physicalIds, byModel = new Map());
  const hit = byModel.get(input.modelId);
  // `relationships` is not part of the key: it is a function of the same store
  // and mutation view, and a new id set is built whenever those change.
  if (hit && hit.geometryResult === input.geometryResult && hit.geometryReady === input.geometryReady) return hit.count;
  const count = countShapedObjects(input.physicalIds, {
    relationships: input.relationships,
    meshedIds: sharedModelMeshedIds(input.modelId, input.geometryResult, input.toLocalId),
    geometryReady: input.geometryReady,
  });
  byModel.set(input.modelId, { geometryResult: input.geometryResult, geometryReady: input.geometryReady, count });
  return count;
}
