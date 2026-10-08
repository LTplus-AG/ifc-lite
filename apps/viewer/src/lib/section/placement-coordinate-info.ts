/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { FederatedModel } from '@/store';
import type { PlacementState } from '@/lib/model-placement/state';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { displayedTranslation } from '@/lib/model-placement/state';
import { toRenderTranslation } from '@/lib/model-placement/translation';
import { getGlobalRenderer } from '@/hooks/useBCF';


/** Canonical live placed section extent shared by scene hooks and alignment cuts. */
export function placementCoordinateInfo(source: CoordinateInfo | undefined,
  models: ReadonlyMap<string, FederatedModel>, placement: PlacementState): CoordinateInfo | undefined {
    if (!source || (!placement.placements.size && !placement.preview)) return source;
    const renderer = getGlobalRenderer(), indices = modelIndices(models);
    const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const [id, model] of models) {
      if (!model.visible) continue;
      const handle = model.pointCloudHandleId === undefined ? undefined : { id: model.pointCloudHandleId };
      const live = renderer?.getModelPlacementBounds(indices.get(id) ?? 0, handle);
      const bounds = live ?? model.geometryResult?.coordinateInfo?.shiftedBounds;
      if (!bounds) continue;
      const delta = live ? [0, 0, 0] : toRenderTranslation(displayedTranslation(placement, id));
      for (const [axis, index] of [['x', 0], ['y', 1], ['z', 2]] as const) {
        if (!Number.isFinite(bounds.min[axis]) || !Number.isFinite(bounds.max[axis])) continue;
        min[axis] = Math.min(min[axis], bounds.min[axis] + delta[index]);
        max[axis] = Math.max(max[axis], bounds.max[axis] + delta[index]);
      }
    }
    return Object.values(min).every(Number.isFinite) && Object.values(max).every(Number.isFinite)
      ? { ...source, shiftedBounds: { min, max } } : source;
}
