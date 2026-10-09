/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The storey plan frame the authored-element mirror meshes are drawn through
 * (#6233). Picks go the other way through the storey workplane
 * (`lib/commands/modeling/workplane.ts`), which takes its plan from here.
 *
 * Every builder (`addWallToStore`, `addColumnToStore`, …) anchors its element
 * to the storey's own placement, so the coordinates it is handed are STOREY-
 * LOCAL: a reader applies the storey's whole placement chain (storey axis ∘
 * building ∘ site) to them. A click, a hover and the instant 3D mirror all
 * live in the MODEL frame — the rendered geometry, which already has that
 * chain baked in. Handing a model-frame click to a builder as if it were
 * storey-local applies the chain a second time: on the demo project the
 * storey hangs 3 m east and 3 m north of the model origin, so every element
 * the Model workspace authored landed 3 m away on export and reload, while
 * the mirror drew it under the cursor.
 *
 * Same frame algebra as the Room tool's space writer, reused rather
 * than re-derived: `storeyPlanFrame` composes the chain, and the offset back to
 * the file's own world frame is the whole `world = render + originShift + rtc`
 * reconstruction — `roomFramePlanOffsets` (the TS origin shift, which Space
 * Sketch's room frame already carries) plus `roomFrameToModelWorld` (the survey
 * anchor the wasm path subtracted). Both are zero for a model near the origin.
 *
 * Unlike the Room tool this falls back to the identity instead of refusing when
 * the chain will not resolve: that is exactly what the tool did before for
 * every storey, and a storey authored in this session (no source record) has
 * no chain to read. Refusing would block authoring outright on such a storey.
 */

import { storeyPlanFrame, fromStoreyLocal, type StoreyPlanFrame } from './storey-plan-frame.js';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { roomFramePlanOffsets, roomFrameToModelWorld } from './room-wall-rects.js';

type Vec2 = [number, number];

export interface StoreyAuthoringFrame {
  /** Current placement could not be verified; callers must not render its identity placeholder. */
  unavailable?: true;
  /** The storey's chain as a planar rigid motion in the model's world frame. */
  plan: StoreyPlanFrame;
  /** Model-world = rendered model frame + this (origin shift + survey anchor). */
  offset: Vec2;
}

const IDENTITY_PLAN: StoreyPlanFrame = { origin: [0, 0], axisX: [1, 0] };

/** Resolve the frame a storey's authored elements are written in. */
export function storeyAuthoringFrame(
  store: IfcDataStore | null | undefined,
  storeyExpressId: number,
  coordinateInfo: CoordinateInfo | undefined,
  view?: MutablePropertyView | null,
): StoreyAuthoringFrame {
  const plan = store ? storeyPlanFrame(store, storeyExpressId, view) : null;
  const { cx, cy } = roomFramePlanOffsets(coordinateInfo);
  const { dx, dy } = roomFrameToModelWorld(coordinateInfo);
  return { plan: plan ?? IDENTITY_PLAN, offset: [cx + dx, cy + dy],
    ...(view && !plan ? { unavailable: true as const } : {}) };
}

/** Storey-local plan point → the rendered model frame. Inverse of the above. */
export function storeyLocalToModelPlan(frame: StoreyAuthoringFrame, p: Vec2): Vec2 {
  const world = fromStoreyLocal(frame.plan, p);
  return [world[0] - frame.offset[0], world[1] - frame.offset[1]];
}
