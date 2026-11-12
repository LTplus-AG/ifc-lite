/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ModelMetadataPanel`'s "Elements with Geometry" number, pulled out so it
 * can be unit-tested without a DOM.
 *
 * The row is labeled "Elements with Geometry", so it must answer the same
 * question every other object count in the app answers
 * (`lib/object-count.ts`): a physical `IfcElement` (schema test) that
 * produced a mesh, directly or through `IfcRelAggregates` (shape test).
 * Before this, it summed `spatialHierarchy.byStorey` array lengths — raw
 * `IfcRelContainedInSpatialStructure` membership, no schema filter and no
 * geometry filter — so a storey holding an `IfcBuildingElementProxy` with
 * `Representation = $` (no shape) read one higher than the hierarchy trees
 * and the StatusBar, which both apply the filter the label claims.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { countEffectiveEntityTypes } from '@ifc-lite/data';
import { collectEffectivePhysicalEntityIds } from '@/lib/physical-objects';
import { collectMeshedIds, countShapedObjects, sharedShapedObjectCount } from '@/lib/object-count';
import { ownedAggregationRelationships } from '@/utils/entity-ownership';

export interface ModelStats {
  storeys: number;
  elementsWithGeometry: number;
}

export interface ModelStatsGeometryContext {
  /** The displayed model's live mutation view, when it has one. */
  mutationView?: MutablePropertyView | null;
  /** Stable membership prepared by the panel across geometry-only renders. */
  physicalIds?: ReadonlySet<number>;
  /** Whether an empty geometry result is authoritative rather than provisional. */
  geometryReady: boolean;
  /** Resolve a renderer/global id only when it belongs to the displayed model (`modelLocalIdResolver`). */
  toLocalId: (globalId: number) => number | undefined;
  /** The displayed model's id: with `physicalIds` it keys the walk shared with the status bar. */
  modelId?: string;
}

/**
 * `dataStore`'s spatial/type indices are model-local express ids while a
 * federated `geometryResult` uses renderer/global ids. The caller supplies a
 * FederationRegistry-backed resolver so ownership and the single-model
 * fallback stay canonical; IDs belonging to another model are ignored.
 */
export function computeModelStats(
  dataStore: IfcDataStore | null | undefined,
  geometryResult: GeometryResult | null | undefined,
  geometry: ModelStatsGeometryContext,
): ModelStats {
  if (!dataStore?.spatialHierarchy) {
    return { storeys: 0, elementsWithGeometry: 0 };
  }
  const storeys = countEffectiveEntityTypes(dataStore, geometry.mutationView).get('IFCBUILDINGSTOREY') ?? 0;
  const physicalIds = geometry.physicalIds ?? collectEffectivePhysicalEntityIds(dataStore, geometry.mutationView);
  const relationships = ownedAggregationRelationships(dataStore, geometry.mutationView);
  // Shared with the status bar only when the caller names the model and passes
  // the shared physical-id set; the cache is keyed by both.
  const elementsWithGeometry = geometry.modelId !== undefined && geometry.physicalIds
    ? sharedShapedObjectCount({ modelId: geometry.modelId, physicalIds, geometryResult, geometryReady: geometry.geometryReady, relationships, toLocalId: geometry.toLocalId })
    : countShapedObjects(physicalIds, { relationships, meshedIds: localMeshedIds(geometryResult, geometry.toLocalId), geometryReady: geometry.geometryReady });
  return { storeys, elementsWithGeometry };
}

function localMeshedIds(geometryResult: GeometryResult | null | undefined, toLocalId: (id: number) => number | undefined): Set<number> {
  const ids = new Set<number>();
  for (const globalId of collectMeshedIds(geometryResult)) {
    const localId = toLocalId(globalId);
    if (localId !== undefined) ids.add(localId);
  }
  return ids;
}
