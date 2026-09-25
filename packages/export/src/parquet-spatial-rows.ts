/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EffectiveEntityIndex } from './effective-index.js';
import type { parquetRelationshipRows } from './parquet-relationship-rows.js';

type RelationshipRows = ReturnType<typeof parquetRelationshipRows>;

export interface SpatialRow {
  ElementId: number;
  StoreyId: number;
  BuildingId: number;
  SiteId: number;
  SpaceId: number;
}

/** Resolve the spatial table from the same live relationship edges exported to BOS. */
export function parquetSpatialRows(
  relationships: RelationshipRows,
  effective: EffectiveEntityIndex,
): SpatialRow[] {
  const parentOf = new Map<number, number>();
  const containerOf = new Map<number, number>();
  for (let i = 0; i < relationships.RelId.length; i++) {
    const source = relationships.SourceId[i]!;
    const target = relationships.TargetId[i]!;
    if (relationships.RelType[i] === 'IfcRelAggregates') parentOf.set(target, source);
    if (relationships.RelType[i] === 'IfcRelContainedInSpatialStructure') containerOf.set(target, source);
  }

  const rows: SpatialRow[] = [];
  for (const [elementId, containerId] of containerOf) {
    if (!effective.has(elementId)) continue;
    let storeyId = -1;
    let buildingId = -1;
    let siteId = -1;
    let spaceId = -1;
    let current: number | undefined = containerId;
    const seen = new Set<number>();
    // File-supplied aggregation can cycle. Iteration and the visited set
    // bound the walk without rejecting legitimate deep spatial hierarchies.
    while (current !== undefined && !seen.has(current) && effective.has(current)) {
      seen.add(current);
      switch (effective.typeOf(current)) {
        case 'IFCSPACE': if (spaceId < 0) spaceId = current; break;
        case 'IFCBUILDINGSTOREY': if (storeyId < 0) storeyId = current; break;
        case 'IFCBUILDING': if (buildingId < 0) buildingId = current; break;
        case 'IFCSITE': if (siteId < 0) siteId = current; break;
      }
      current = parentOf.get(current);
    }
    if (storeyId < 0) continue;
    rows.push({ ElementId: elementId, StoreyId: storeyId, BuildingId: buildingId, SiteId: siteId, SpaceId: spaceId });
  }
  rows.sort((a, b) => a.ElementId - b.ElementId);
  return rows;
}
