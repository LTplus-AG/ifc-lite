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

export function topOfWalls(s: ViewerState, modelId: string, storeyId: number): number {
  const target = modelEditTarget(s, modelId);
  let top: number | null = null;
  if (target) {
    for (const id of extractWallSegmentsForStorey(target.dataStore, storeyId, target.view).contributingWallIds) {
      const wall = readWallMetres(target, id);
      if (wall) top = Math.max(top ?? -Infinity, wall.start[2] + wall.height);
    }
  }
  if (top !== null) return top;
  const storeys = modelStoreys(s, modelId);
  const here = storeys.findIndex((storey) => storey.expressId === storeyId);
  const above = here >= 0 ? storeys[here + 1] : undefined;
  return above ? above.elevation - storeys[here].elevation : authoringDim(s.authoringDefaults, 'wall', 'Height');
}
