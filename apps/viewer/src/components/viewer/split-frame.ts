/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Split tool's pick frame (#6233). Every split chain (`wall-edit`,
 * `linear-element-edit`, `slab-edit`) reads an element's placement relative
 * to its storey, so cut distances, cut lines and footprints are STOREY-LOCAL
 * metres. A viewport pick is in the renderer frame. Crossing between them
 * takes the model's reposition (`pickPlacement`) and the storey's own
 * placement chain — the same `storeyAuthoringFrame` Add Element writes with.
 * Using the model frame alone put every cut a whole storey offset away from
 * the cursor on a storey that does not sit at the model origin (the demo
 * project's storey hangs 3 m east and 3 m north).
 */

import { useViewerStore } from '@/store';
import { fromRenderTranslation, toRenderTranslation } from '@/lib/model-placement/translation.js';
import { modelPointToWorkspacePoint, workspacePointToModelFrame } from '@/lib/model-placement/rotation.js';
import { modelPlanToStoreyLocal, storeyAuthoringFrame, storeyLocalToModelPlan, type StoreyAuthoringFrame } from '@/lib/authoring/storey-authoring-frame';
import { pickPlacement } from './pick-frame.js';

type Vec3 = [number, number, number];

interface SplitFrame {
  frame: StoreyAuthoringFrame;
  /** Storey floor height in the model frame (metres). */
  elevation: number;
}

/** The storey frame `expressId` is split in, or null when it is in no storey. */
function splitFrame(modelId: string, expressId: number): SplitFrame | null {
  const model = useViewerStore.getState().models.get(modelId);
  const hierarchy = model?.ifcDataStore?.spatialHierarchy;
  // @raw-entity-enumeration-ok point lookup; authored elements are registered into this map (registerAuthoredElement), and the split commit gates on the same map
  const storeyId = hierarchy?.elementToStorey.get(expressId);
  if (storeyId === undefined) return null;
  return {
    frame: storeyAuthoringFrame(model?.ifcDataStore, storeyId, model?.geometryResult?.coordinateInfo),
    elevation: hierarchy?.storeyElevations?.get(storeyId) ?? 0,
  };
}

/**
 * Renderer-frame pick → `expressId`'s storey-local frame: plan XY on the
 * storey's axes, Z the height above its floor (what a column's vertical axis
 * projects against). Null when the element is in no storey.
 */
export function pickToSplitLocal(point: { x: number; y: number; z: number }, modelId: string, expressId: number): Vec3 | null {
  const f = splitFrame(modelId, expressId);
  if (!f) return null;
  const m = workspacePointToModelFrame(fromRenderTranslation(point), pickPlacement(modelId));
  const [x, y] = modelPlanToStoreyLocal(f.frame, [m[0], m[1]]);
  return [x, y, m[2] - f.elevation];
}

/** Storey-local point of `expressId`'s storey → renderer frame. Inverse of {@link pickToSplitLocal}. */
export function splitLocalToRenderer(p: readonly number[], modelId: string, expressId: number): Vec3 | null {
  const f = splitFrame(modelId, expressId);
  if (!f) return null;
  const [x, y] = storeyLocalToModelPlan(f.frame, [p[0], p[1]]);
  return toRenderTranslation(modelPointToWorkspacePoint([x, y, p[2] + f.elevation], pickPlacement(modelId)));
}

/**
 * A storey-local axis direction as the overlay's `[ax, ay, az]` convention
 * (renderer `x = ax, y = az, z = -ay`), after the storey's and the model's
 * rotation — so the guide stays perpendicular on a rotated storey.
 */
export function splitAxisToRendererConvention(
  cut: readonly number[],
  axis: readonly number[],
  modelId: string,
  expressId: number,
): Vec3 | null {
  const a = splitLocalToRenderer(cut, modelId, expressId);
  const b = splitLocalToRenderer([cut[0] + axis[0], cut[1] + axis[1], cut[2] + axis[2]], modelId, expressId);
  if (!a || !b) return null;
  return [b[0] - a[0], -(b[2] - a[2]), b[1] - a[1]];
}
