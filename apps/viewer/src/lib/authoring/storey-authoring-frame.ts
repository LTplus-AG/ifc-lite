/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one plan-frame crossing between what the viewer draws and what the
 * `@ifc-lite/create` in-store builders write (#6233).
 *
 * Every builder (`addWallToStore`, `addColumnToStore`, …) anchors its element
 * to the storey's own placement, so the coordinates it is handed are STOREY-
 * LOCAL: a reader applies the storey's whole placement chain (storey axis ∘
 * building ∘ site) to them. A click, a hover and the instant 3D mirror all
 * live in the MODEL frame — the rendered geometry, which already has that
 * chain baked in. Handing a model-frame click to a builder as if it were
 * storey-local applies the chain a second time: on the demo project the
 * storey hangs 3 m east and 3 m north of the model origin, so every element
 * the Add Element tool authored landed 3 m away on export and reload, while
 * the mirror drew it under the cursor.
 *
 * Same frame algebra as Space Sketch's bake (`useSpaceBake.ts`), reused rather
 * than re-derived: `storeyPlanFrame` composes the chain, and
 * `roomFrameToModelWorld` supplies the survey anchor the wasm path subtracted
 * from the rendered geometry (zero for any model near the origin).
 *
 * Unlike Space Sketch this falls back to the identity instead of refusing when
 * the chain will not resolve: that is exactly what the tool did before for
 * every storey, and a storey authored in this session (no source record) has
 * no chain to read. Refusing would block authoring outright on such a storey.
 */

import { storeyPlanFrame, toStoreyLocal, fromStoreyLocal, type StoreyPlanFrame } from '@ifc-lite/create';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { IfcDataStore } from '@ifc-lite/parser';
import { roomFrameToModelWorld } from '@/lib/wall-rects-from-meshes';

type Vec2 = [number, number];

export interface StoreyAuthoringFrame {
  /** The storey's chain as a planar rigid motion in the model's world frame. */
  plan: StoreyPlanFrame;
  /** Model-world = rendered model frame + this (the survey anchor). */
  offset: Vec2;
}

const IDENTITY_PLAN: StoreyPlanFrame = { origin: [0, 0], axisX: [1, 0] };

/** Resolve the frame a storey's authored elements are written in. */
export function storeyAuthoringFrame(
  store: IfcDataStore | null | undefined,
  storeyExpressId: number,
  coordinateInfo: CoordinateInfo | undefined,
): StoreyAuthoringFrame {
  const plan = store ? storeyPlanFrame(store, storeyExpressId) : null;
  const { dx, dy } = roomFrameToModelWorld(coordinateInfo);
  return { plan: plan ?? IDENTITY_PLAN, offset: [dx, dy] };
}

/** Rendered model-frame plan point → the storey-local frame a builder writes. */
export function modelPlanToStoreyLocal(frame: StoreyAuthoringFrame, p: Vec2): Vec2 {
  return toStoreyLocal(frame.plan, [p[0] + frame.offset[0], p[1] + frame.offset[1]]);
}

/** Storey-local plan point → the rendered model frame. Inverse of the above. */
export function storeyLocalToModelPlan(frame: StoreyAuthoringFrame, p: Vec2): Vec2 {
  const world = fromStoreyLocal(frame.plan, p);
  return [world[0] - frame.offset[0], world[1] - frame.offset[1]];
}

/** Whether the storey's local axes are turned against the model's. */
export function isRotatedFrame(frame: StoreyAuthoringFrame): boolean {
  return Math.abs(frame.plan.axisX[1]) > 1e-9 || frame.plan.axisX[0] < 0;
}
