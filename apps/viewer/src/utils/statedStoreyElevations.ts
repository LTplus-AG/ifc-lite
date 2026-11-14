/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The storey elevations a format states, for a hierarchy rebuilt without them.
 *
 * Its own file because `spatialHierarchy.ts` is at its module-size budget.
 */

import { isStoreyLikeSpatialType, type SpatialHierarchy, type SpatialNode } from '@ifc-lite/data';

import { calculateStoreyHeights } from './localParsingUtils';

/**
 * Give a rebuilt hierarchy the storey elevations its format states.
 *
 * `rebuildSpatialHierarchy` reads elevations out of the source STEP bytes, so
 * a store that has none (a `.3dm`, whose layer stamps carry them) comes back
 * with every storey at `undefined`. The maps mutated here are the ones the
 * hierarchy's own `getStoreyByElevation` closes over, so storey ordering, the
 * elevation badges, Exploded and the storey-based section read the values the
 * file stated. Heights follow from the elevations, as on every other path that
 * lands them (`useIfcLoader`, `ifcCacheDecode`, `serverSpatialHierarchy`).
 *
 * `stated` is keyed by express id and may name any spatial node; only a storey
 * reaches the map `getStoreyByElevation` resolves against.
 */
export function applyStatedStoreyElevations(
  hierarchy: SpatialHierarchy,
  stated: ReadonlyMap<number, number>,
): void {
  if (stated.size === 0) return;
  const pending: SpatialNode[] = [hierarchy.project];
  while (pending.length > 0) {
    const node = pending.pop()!;
    const elevation = stated.get(node.expressId);
    if (elevation !== undefined) {
      node.elevation = elevation;
      if (isStoreyLikeSpatialType(node.type)) hierarchy.storeyElevations.set(node.expressId, elevation);
    }
    for (const child of node.children) pending.push(child);
  }
  for (const [storeyId, height] of calculateStoreyHeights(hierarchy.storeyElevations)) {
    hierarchy.storeyHeights.set(storeyId, height);
  }
}
