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
import { collectPhysicalEntityIds } from '@/lib/physical-objects';
import { collectMeshedIds, countShapedObjects } from '@/lib/object-count';
import type { AggregationRelationships } from '@/utils/aggregation';

export interface ModelStats {
  storeys: number;
  elementsWithGeometry: number;
}

/**
 * `dataStore`'s spatial/type indices are model-local express ids.
 * `geometryResult`'s ids are global (`originalExpressId + idOffset`,
 * `store/types.ts`) for a federated model, so `idOffset` converts them back
 * before the schema/shape tests run. `idOffset` is 0 for the legacy
 * single-model path, so the subtraction is a no-op there.
 */
export function computeModelStats(
  dataStore: IfcDataStore | null | undefined,
  geometryResult: GeometryResult | null | undefined,
  idOffset: number,
): ModelStats {
  if (!dataStore?.spatialHierarchy) {
    return { storeys: 0, elementsWithGeometry: 0 };
  }
  const storeys = dataStore.spatialHierarchy.byStorey.size;
  const meshedIds = collectMeshedIds(geometryResult, (id) => id - idOffset);
  const physicalIds = collectPhysicalEntityIds(dataStore.entityIndex?.byType);
  const elementsWithGeometry = countShapedObjects(physicalIds, {
    relationships: dataStore.relationships as AggregationRelationships | undefined,
    meshedIds,
    // A still-streaming model may have no geometry result yet; the shape
    // test must then stand aside (see `object-count.ts`'s "Before geometry
    // exists") rather than read as zero.
    geometryReady: geometryResult != null,
  });
  return { storeys, elementsWithGeometry };
}
