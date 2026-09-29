/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pointer routing for the Model workspace's plan (charter #6232, M2 §1.5),
 * the plan's counterpart of `commandPointer.ts`. The cursor comes from the
 * inverse `Fit` (already workplane-local), `metresPerPixel` is `1 / scale`,
 * and the point goes through the one shared solver (`solveCommandSnap`) into
 * the same runtime the 3D viewport feeds, so a wall drawn here is the same
 * gesture, ghost and undo step as one drawn in 3D.
 *
 * With no command running a click selects instead (`viewport-selection.ts`,
 * the 3D click's own path): Shift toggles, an empty click clears. A press on
 * one of the selected element's handles (`plan-handles.ts`) starts the
 * command behind it, the same command its 3D handle starts, and the drag then
 * feeds it like any running command.
 */

import { commandDoubleClick, commandPointerDown, commandPointerMove, getCommandRuntime } from '@/lib/commands/modeling/runtime';
import { profileOf, semanticSource, solveCommandSnap, type PointerModifiers } from '@/lib/commands/modeling/snap-solve';
import type { SnapProfile, SnapResult, SnapSource, Vec2 } from '@/lib/snap/types';
import { selectPickedGlobalId, toggleGlobalIdInSelection } from '../viewport-selection';
import { beginWallEndpointDrag } from '@/lib/commands/modeling/commands/wall-move-endpoint';
import { beginHostedSlide } from '@/lib/commands/modeling/commands/hosted-slide';
import { beginPlanMove } from '@/lib/commands/modeling/commands/plan-move';
import { PLAN_CUT_SOURCE_ID } from './plan-cut-source';
import type { PlanHandle } from './plan-handles';

export interface PlanPointerInput {
  /** The cursor, workplane-local metres. */
  local: Vec2;
  metresPerPixel: number;
  mods: PointerModifiers;
  /** Snapping is on (the viewer's one `snapEnabled` flag). */
  snapping: boolean;
  /** The plan's own sources (cut linework, grid); the semantic wall source is added here. */
  planSources: readonly SnapSource[];
}

/** The running command's profile, consulting the plan's cut linework too. */
function planProfile(profile: SnapProfile): SnapProfile {
  return profile.sources.includes(PLAN_CUT_SOURCE_ID) ? profile : { ...profile, sources: [...profile.sources, PLAN_CUT_SOURCE_ID] };
}

/** Solve the plan cursor for the running command, or null when none runs on a workplane. */
export function resolvePlanSnap(input: PlanPointerInput): SnapResult | null {
  const runtime = getCommandRuntime();
  const { command, ctx } = runtime;
  if (!command || !ctx?.workplane) return null;
  const snapping = input.snapping && !input.mods.altKey;
  const sources = snapping ? [semanticSource(ctx.modelId), ...input.planSources] : [];
  return solveCommandSnap(runtime, ctx.workplane, {
    cursor: input.local,
    metresPerPixel: input.metresPerPixel,
    sources,
    mods: input.mods,
    profile: planProfile(profileOf(command)),
  });
}

/** Feed a plan pointer event to the running command. False when no command took it. */
export function routePlanPointer(kind: 'move' | 'down', input: PlanPointerInput): boolean {
  const snap = resolvePlanSnap(input);
  if (!snap) return false;
  // The second click of a double-click (detail 2) closes a polygon, as in 3D.
  if (kind === 'down') ((input.mods.detail ?? 1) >= 2 ? commandDoubleClick : commandPointerDown)(snap);
  else commandPointerMove(snap);
  return true;
}

/** A Select click in the plan on `globalId` (null: empty space). */
export function selectFromPlan(globalId: number | null, toggle: boolean): void {
  if (toggle) {
    if (globalId !== null) toggleGlobalIdInSelection(globalId);
    return;
  }
  selectPickedGlobalId(globalId);
}

/**
 * A plan handle was grabbed: start its command. The command runs until the
 * pointer is released anywhere (a window `pointerup`), writing one undo step.
 * True when the command started.
 */
export function beginPlanHandleDrag(handle: PlanHandle): boolean {
  if (handle.kind === 'wallEnd') beginWallEndpointDrag(handle.which);
  else if (handle.kind === 'slide') beginHostedSlide();
  else beginPlanMove(handle.at);
  return getCommandRuntime().command !== null;
}
