/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the product-oriented trees ("By Class", "By Type") list, and which ids
 * their rows act on. Extracted from `treeDataBuilder.ts` so the membership
 * rule and the id substitution sit together, away from the spatial tree.
 */

import { IfcTypeEnumFromString, isSpatialStructureType } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { ownedAggregationRelationships } from '@/utils/aggregation-ownership';
import { useViewerStore, type FederatedModel } from '@/store';
import {
  collectAggregatedDescendants,
  getAggregatedChildren,
  hasAggregatedGeometry,
} from '@/utils/aggregation';
import { isPhysicalObjectType } from '@/lib/physical-objects';
import { isProductTreeClass } from './productTreeClasses';

/** Resolve a model-local express id to the federated global id the tree uses. */
export function resolveTreeGlobalId(
  modelId: string,
  expressId: number,
  models: Map<string, FederatedModel>
): number {
  if (modelId === 'legacy' || !models.has(modelId)) {
    return expressId;
  }

  return useViewerStore.getState().toGlobalId(modelId, expressId);
}

/** Per-model view of "what renders" for the 3D-oriented class/type trees, with
 *  assemblies resolved to their `IfcRelAggregates` parts. */
export interface AssemblyGeometry {
  /** The entity belongs in a product tree AND passes the geometry filter (it
   *  renders, or an aggregated part does). `typeName` and `globalId` are the
   *  caller's already-resolved values — passed in rather than recomputed,
   *  because every caller needs both for the rows that survive. */
  renders(typeName: string, expressId: number, globalId: number): boolean;
  /**
   * A physical element that belongs in a product tree but has neither its
   * own geometry nor a geometry-bearing aggregated part — the row `renders`
   * drops. `false` while the geometry filter is inert (streaming): absence
   * is unanswerable until geometry is known, so nothing is "other" yet
   * (#4764's mid-load requirement — see `makeShapeTest`'s `geometryKnown`
   * gate, the same contract). A caller that gets `false` from BOTH `renders`
   * and `isOther` should drop the row entirely — it never belonged in a
   * products tree (not a product-tree class, or a non-physical class with no
   * geometry of its own).
   */
  isOther(typeName: string, expressId: number, globalId: number): boolean;
  /** Geometry-bearing aggregated parts for a row whose own id carries none —
   *  what click / eye / isolate must act on instead (undefined if not an
   *  assembly, or if the row renders under its own id). `typeName` is the
   *  caller's already-looked-up class name (needed for every row that
   *  survives `renders`, so it costs nothing extra here). */
  parts(expressId: number, typeName: string): number[] | undefined;
}

/**
 * Admit geometry-less assemblies into the By-Class / By-Type trees (#1133
 * applied beyond the spatial tree).
 *
 * An `IfcElementAssembly` — and any element used as a decomposition container —
 * has no representation of its own; the meshes sit on its `IfcRelAggregates`
 * parts. The raw `geometricIds` test therefore dropped assemblies from the class
 * tree and reported their types as having 0 instances, even though the thing is
 * plainly visible in 3D. The filter itself stays: an entity with neither
 * geometry nor a geometry-bearing part (a property set, a relationship object,
 * a container holding nothing renderable) is still excluded, so the tree keeps
 * out non-renderable clutter.
 *
 * Spatial structure classes are deliberately NOT admitted this way: IfcProject
 * aggregates the site, building and storeys, so a descendant test would drag
 * the entire spatial skeleton into a tree that is meant to list products. The
 * guard applies in BOTH `renders` and `parts`, and independent of whether the
 * geometry filter itself is active — during initial streaming `geometricIds`
 * is empty (no filter yet), and without a filter-independent guard `parts`
 * would hand IfcProject the descendant ids of the entire spatial skeleton as
 * "aggregated parts" to isolate. The name check is case-insensitive
 * (`IfcTypeEnumFromString` upper-cases before lookup) because every current
 * caller already canonicalises the type string on the way in, but nothing
 * about this predicate should silently depend on that.
 *
 * `hasAggregatedGeometry` short-circuits and shares one memo per model per
 * rebuild, and the `parts` walk is gated behind a single direct-children lookup,
 * so a whole-model scan costs one map probe for the entities (the vast majority)
 * that decompose nothing.
 */
export function makeAssemblyGeometry(
  dataStore: IfcDataStore,
  modelId: string,
  models: Map<string, FederatedModel>,
  geometricIds: Set<number> | undefined,
  geometryKnown = !!geometricIds && geometricIds.size > 0,
  view?: MutablePropertyView | null,
): AssemblyGeometry {
  const applyFilter = geometryKnown;
  const knownGeometryIds = geometricIds ?? new Set<number>();
  const relationships = ownedAggregationRelationships(dataStore, view);
  const toGlobal = (expressId: number) => resolveTreeGlobalId(modelId, expressId, models);
  const cache = new Map<number, boolean>();
  const isSpatial = (typeName: string) => isSpatialStructureType(IfcTypeEnumFromString(typeName));
  return {
    renders(typeName, expressId, globalId) {
      // The class test comes first and is independent of the geometry filter.
      // While a model streams, `geometricIds` is still empty and the filter is
      // inert — without a class test every parsed entity passed, so groups,
      // zones, systems and the spatial chain appeared in the products trees
      // until the first geometry batch landed, and a count read off the tab in
      // that window counted them.
      if (!isProductTreeClass(typeName)) return false;
      // While the filter is inert nothing can be known to be meshless, so
      // every physical object is listed optimistically and the set narrows as
      // geometry arrives. The shown-but-not-counted classes earn their row by
      // actually rendering, which is the whole reason they are shown — so a
      // non-object never appears in the streaming window, which is where a
      // count read off the tab used to pick up groups, zones and containers.
      const physical = isPhysicalObjectType(typeName);
      if (!applyFilter) return physical;
      if (knownGeometryIds.has(globalId)) return true;
      if (!physical) return false;
      return hasAggregatedGeometry(relationships, expressId, toGlobal, knownGeometryIds, cache);
    },
    isOther(typeName, expressId, globalId) {
      // Mirrors `renders` exactly, but isolates the ONE branch that means
      // "belongs here, but has no shape" rather than "belongs here" or
      // "doesn't belong at all" — see the interface doc above.
      if (!applyFilter) return false;
      if (!isProductTreeClass(typeName)) return false;
      if (knownGeometryIds.has(globalId)) return false;
      if (!isPhysicalObjectType(typeName)) return false;
      return !hasAggregatedGeometry(relationships, expressId, toGlobal, knownGeometryIds, cache);
    },
    parts(expressId, typeName) {
      if (!relationships) return undefined;
      // Defence in depth: `renders` already keeps every spatial container out
      // unless it renders under its own id, and such a row returns below. The
      // guard stays because handing IfcProject the whole spatial skeleton as
      // "aggregated parts" to isolate is the failure it was written for.
      if (isSpatial(typeName)) return undefined;
      if (applyFilter && knownGeometryIds.has(toGlobal(expressId))) return undefined;
      if (getAggregatedChildren(relationships, expressId).length === 0) return undefined;
      const ids = collectAggregatedDescendants(relationships, expressId)
        .map(toGlobal)
        .filter((id) => !applyFilter || knownGeometryIds.has(id));
      return ids.length > 0 ? ids : undefined;
    },
  };
}

/** Ids to act on (class/type-group `globalIds`, click-to-isolate targets) for
 *  a set of rows: a geometry-less assembly stands in for its geometry-bearing
 *  parts, deduped across the whole set. Shared by `buildTypeTree`'s group node
 *  and `buildIfcTypeTree`'s class/type nodes — same substitution, same dedup. */
export function partsOrOwnIds(rows: readonly { globalId: number; parts?: number[] }[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    for (const id of row.parts && row.parts.length > 0 ? row.parts : [row.globalId]) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
