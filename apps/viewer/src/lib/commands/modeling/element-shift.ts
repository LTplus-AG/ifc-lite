/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A plan shift as the placement write it is (charter #6232, C4): the
 * translation, in the frame the element's own placement sits in, that moves
 * an element by `shift` (workplane-local metres) on screen. Shared by every
 * command that moves elements by a plan vector without a gizmo.
 *
 * The element's placement is relative to its parent's (a storey, or a
 * rotated wall it is hosted in), so the shift is taken to the element's
 * storey frame, then turned into the parent's by the angle between the two.
 * Null when the element has no storey, no readable placement frame, or no
 * readable own rotation: it cannot be moved by a placement write.
 */

import { hostPlanFrame } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import type { Vec2 } from '@/lib/snap/types';
import { buildStoreyWorkplane, elementStoreyId, isWorkplane } from './workplane.js';
import type { Workplane } from './types.js';

export function parentFrameShift(
  s: ViewerState,
  modelId: string,
  expressId: number,
  plane: Workplane,
  shift: Vec2,
): [number, number, number] | null {
  const dataStore = s.models.get(modelId)?.ifcDataStore;
  const storeyId = elementStoreyId(s, modelId, expressId);
  if (!dataStore || storeyId === null) return null;
  const frame = hostPlanFrame(dataStore, expressId, storeyId, s.mutationViews.get(modelId) ?? null);
  const own = frame ? s.readEntityRotation(modelId, expressId) : null;
  if (!frame || !own || s.readEntityPosition(modelId, expressId) === null) return null;
  const storey = buildStoreyWorkplane(s, modelId, storeyId, 0);
  if (!isWorkplane(storey)) return null;
  const local = (p: Vec2) => storey.renderToLocal(plane.localToRender([p[0], p[1], 0]));
  const a = local([0, 0]), b = local(shift);
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const parentAngle = Math.atan2(frame.axisX[1], frame.axisX[0]) - own.yawZ;
  const c = Math.cos(parentAngle), sn = Math.sin(parentAngle);
  return [dx * c + dy * sn, -dx * sn + dy * c, 0];
}
