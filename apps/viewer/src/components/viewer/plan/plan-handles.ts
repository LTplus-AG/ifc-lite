/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The plan's direct-edit handles (charter #6232, B3): which handles the
 * selected element offers, where they sit in the plan, and which one a press
 * grabs. Pure over the store and the plan's workplane; everything here is
 * workplane-local metres, and the grab is decided in that space too (a
 * handle's reach is a fixed number of pixels, turned into metres at the
 * current zoom), so a handle stays the same size on screen at any zoom.
 *
 * - A wall with an editable axis: an end handle at each end (`wall.moveEndpoint`).
 * - A door, window or opening placed in a wall: a slide handle at its centre
 *   on the wall's axis (`hosted.slide`).
 * - Anything else the plan can move: a move handle at its centre (a wall's
 *   axis midpoint, else the middle of its cut outline) (`plan.move`).
 *
 * Only a single selected element of the session model, on the plan's storey,
 * in Select, and on a model the user may edit, gets handles.
 */

import type { ViewerState } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { canMutate } from '@/store/mutation-permission';
import type { Vec2 } from '@/lib/snap/types';
import type { Vec3, Workplane } from '@/lib/commands/modeling/types';
import { buildStoreyWorkplane, elementStoreyId, isWorkplane } from '@/lib/commands/modeling/workplane';
import type { WallEnd } from '@/lib/commands/modeling/commands/wall-move-endpoint';
import { readHostedSlide, slideHandlePoint } from '@/lib/commands/modeling/commands/hosted-slide';
import { readPlanMoveTarget } from '@/lib/commands/modeling/commands/plan-move';

export type PlanHandle =
  | { readonly kind: 'wallEnd'; readonly which: WallEnd; readonly at: Vec2 }
  /** `axis`: the host wall's direction in the plan (unit), for the handle's arrows. */
  | { readonly kind: 'slide'; readonly at: Vec2; readonly axis: Vec2 }
  | { readonly kind: 'move'; readonly at: Vec2 };

/** A handle's drawn radius, px. */
export const PLAN_HANDLE_RADIUS_PX = 6;
/** How far from a handle's centre a press still grabs it, px. */
export const PLAN_HANDLE_REACH_PX = 10;

/** The one element the handles are for, or null (none, several, or not the session's). */
function singleSelection(s: ViewerState): { modelId: string; expressId: number } | null {
  const id = s.selectedEntityId;
  if (id === null) return null;
  if (s.selectedEntityIds.size > 1 || (s.selectedEntityIds.size === 1 && !s.selectedEntityIds.has(id))) return null;
  return resolveEntityRef(id);
}

/** Storey-local → plan-local, through render space (the storey's and the plan's workplanes). */
function storeyToPlan(s: ViewerState, modelId: string, storeyId: number, plane: Workplane): ((p: Vec3) => Vec2) | null {
  const storey = buildStoreyWorkplane(s, modelId, storeyId, 0);
  if (!isWorkplane(storey)) return null;
  return (p) => {
    const local = plane.renderToLocal(storey.localToRender(p));
    return [local[0], local[1]];
  };
}

/**
 * The selected element's handles in the plan of `plane`; empty when it has
 * none. `outlineCentre`: the middle of its cut outline in the plan, where a
 * non-wall's move handle sits (none without one).
 */
export function selectedPlanHandles(s: ViewerState, plane: Workplane | null, outlineCentre: Vec2 | null = null): PlanHandle[] {
  const session = s.session;
  if (!plane || !session || session.storeyId === null || s.activeTool !== 'select') return [];
  const ref = singleSelection(s);
  if (!ref || ref.modelId !== session.modelId || !s.models.has(ref.modelId) || !canMutate(s, ref.modelId)) return [];
  const { modelId, expressId } = ref;

  // A hosted element is on its host's storey (an opening is contained in none).
  const slide = readHostedSlide(s, modelId, expressId);
  if (slide) {
    if (elementStoreyId(s, modelId, slide.host.expressId) !== session.storeyId) return [];
    const toPlan = storeyToPlan(s, modelId, session.storeyId, plane);
    if (!toPlan) return [];
    const at = slideHandlePoint(slide);
    const [ax, ay] = slide.host.axisX;
    const tip = toPlan([at[0] + ax, at[1] + ay, 0]);
    const centre = toPlan([at[0], at[1], 0]);
    const len = Math.hypot(tip[0] - centre[0], tip[1] - centre[1]) || 1;
    return [{ kind: 'slide', at: centre, axis: [(tip[0] - centre[0]) / len, (tip[1] - centre[1]) / len] }];
  }

  const storeyId = elementStoreyId(s, modelId, expressId);
  if (storeyId !== session.storeyId) return [];
  const movable = readPlanMoveTarget(s, modelId, expressId) !== null;
  const wall = s.readWallEndpoints(modelId, expressId);
  const toPlan = wall ? storeyToPlan(s, modelId, storeyId, plane) : null;
  if (!wall || !toPlan) return movable && outlineCentre ? [{ kind: 'move', at: outlineCentre }] : [];
  const start = toPlan(wall.start), end = toPlan(wall.end);
  const handles: PlanHandle[] = [
    { kind: 'wallEnd', which: 'start', at: start },
    { kind: 'wallEnd', which: 'end', at: end },
  ];
  if (movable) handles.push({ kind: 'move', at: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2] });
  return handles;
}

/** The handle a press at `cursor` (plan-local) grabs: the nearest within reach, or null. */
export function pickPlanHandle(handles: readonly PlanHandle[], cursor: Vec2, metresPerPixel: number): PlanHandle | null {
  const reach = PLAN_HANDLE_REACH_PX * metresPerPixel;
  let best: { handle: PlanHandle; d: number } | null = null;
  for (const handle of handles) {
    const d = Math.hypot(cursor[0] - handle.at[0], cursor[1] - handle.at[1]);
    if (d <= reach && (!best || d < best.d)) best = { handle, d };
  }
  return best?.handle ?? null;
}
