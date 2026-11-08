/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How high a storey's walls reach, above its floor, in metres (#9202): where
 * a roof is drawn. The highest wall the wall reader can measure; for a storey
 * with none, what a wall drawn there would reach, the storey above or else
 * the default wall height.
 */

import { extractWallSegmentsForStorey } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import { authoringDim } from '@/store/slices/authoringDefaultsSlice';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { readWallMetres } from '@/store/slices/mutation-wall-resize';
import { modelStoreys } from './workspace-storeys.js';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { localPlacementHop, type LiveRead } from '../../../../../../packages/create/src/in-store/copy-frame';
import { asRef, createStyleEntityReader } from '../../../../../../packages/create/src/in-store/style-entity-reader';

/**
 * A placement's height above the world origin, in model units; null when a
 * link of its chain does not read. Its frames turn only in plan, so heights add.
 */
function worldZ(read: LiveRead, placementId: number | null): number | null {
  let z = 0;
  const seen = new Set<number>();
  for (let id = placementId; id !== null;) {
    if (seen.has(id)) return null;
    seen.add(id);
    const hop = localPlacementHop(read, id);
    if (!hop) return null;
    z += hop.frame.origin[2];
    id = hop.parentId;
  }
  return z;
}

export function topOfWalls(s: ViewerState, modelId: string, storeyId: number): number {
  const target = modelEditTarget(s, modelId);
  let top: number | null = null;
  if (target) {
    // A wall's own placement may hang from the site or building, not the storey,
    // as some exporters write it: its base is measured from the storey's frame.
    const read = createStyleEntityReader(target.dataStore, target.editor) as LiveRead;
    const scale = getModelLengthUnitScale(target.dataStore);
    const floor = worldZ(read, asRef(read(storeyId)?.attributes[5]));
    for (const id of extractWallSegmentsForStorey(target.dataStore, storeyId, target.view).contributingWallIds) {
      const wall = readWallMetres(target, id);
      if (!wall) continue;
      const own = floor === null ? null : worldZ(read, asRef(read(id)?.attributes[5]));
      const base = own === null || floor === null ? wall.start[2] : (own - floor) * scale;
      top = Math.max(top ?? -Infinity, base + wall.height);
    }
  }
  if (top !== null) return top;
  const storeys = modelStoreys(s, modelId);
  const here = storeys.findIndex((storey) => storey.expressId === storeyId);
  const above = here >= 0 ? storeys[here + 1] : undefined;
  return above ? above.elevation - storeys[here].elevation : authoringDim(s.authoringDefaults, 'wall', 'Height');
}
