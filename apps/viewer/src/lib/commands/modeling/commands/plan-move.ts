/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `plan.move` (charter #6232, B3): drag the selected element by its move
 * handle in the plan. The handle is the base point; the cursor, through the
 * shared snap solver (tracking from the base), is the target. Release writes
 * the shared selection transform in one transaction: one undo step, and the element
 * re-meshed with what it hosts (its openings, doors and windows follow it).
 *
 */

import { hostPlanFrame } from '@ifc-lite/create';
import { PlanMoveLayer } from '@/components/viewer/plan/PlanMoveLayer';
import { useViewerStore } from '@/store';
import type { ViewerState } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { commitElementTransform } from '@/lib/element-transform/commit';
import type { Vec2 } from '@/lib/snap/types';
import { commitCommand, getCommandRuntime, updateCommandGesture } from '../runtime.js';
import { elementStoreyId } from '../workplane.js';
import type { CommandContext, ModelingCommand } from '../types.js';

export interface PlanMoveTarget {
  readonly modelId: string;
  readonly expressId: number;
  readonly storeyId: number;
}

export interface PlanMoveGesture {
  readonly target: PlanMoveTarget | null;
  /** The grabbed point and the cursor, workplane-local. */
  readonly base: Vec2 | null;
  readonly to: Vec2 | null;
}

/** Below this a move is no move (metres). */
const MIN_MOVE = 1e-4;

/**
 * `expressId` as something the plan can move, or null: it needs a storey, a
 * placement whose frame reaches that storey's, and a readable own rotation.
 * The shared transform writer resolves the parent frame at commit.
 */
export function readPlanMoveTarget(s: ViewerState, modelId: string, expressId: number): PlanMoveTarget | null {
  const dataStore = s.models.get(modelId)?.ifcDataStore;
  const storeyId = elementStoreyId(s, modelId, expressId);
  if (!dataStore || storeyId === null) return null;
  const frame = hostPlanFrame(dataStore, expressId, storeyId, s.mutationViews.get(modelId) ?? null);
  const own = frame ? s.readEntityRotation(modelId, expressId) : null;
  if (!frame || !own || s.readEntityPosition(modelId, expressId) === null) return null;
  return { modelId, expressId, storeyId };
}

function init(ctx: CommandContext): PlanMoveGesture {
  const s = ctx.get();
  if (s.selectedEntityId === null) return { target: null, base: null, to: null };
  const { modelId, expressId } = resolveEntityRef(s.selectedEntityId);
  return { target: readPlanMoveTarget(s, modelId, expressId), base: null, to: null };
}

const moved = (g: PlanMoveGesture): boolean =>
  g.base !== null && g.to !== null && Math.hypot(g.to[0] - g.base[0], g.to[1] - g.base[1]) >= MIN_MOVE;

export const PLAN_MOVE: ModelingCommand<PlanMoveGesture> = {
  id: 'plan.move',
  labelKey: 'planHandles.move.label',
  hud: { Plan: PlanMoveLayer, hint: () => 'planHandles.move.hint' },
  snap: 'modeling',
  init,
  snapQuery: (g) => ({ anchor: g.base, chain: g.base ? [g.base] : [], locks: {} }),
  pointerMove: (g, s) => (g.base ? { ...g, to: s.local } : g),
  pointerDown: (g) => g,
  validate: (g) => (g.target && moved(g) ? { ok: true } : { ok: false, reasonKey: 'planHandles.move.notMovable' }),
  commit(g, tx) {
    const { target, base, to } = g;
    if (!target || !base || !to || !tx.workplane) throw new Error('Nothing to move');
    return commitElementTransform(tx, target.modelId, [target.expressId], {
      kind: 'move', from: tx.workplane.localToRender([base[0], base[1], 0]),
      to: tx.workplane.localToRender([to[0], to[1], 0]),
    });
  },
  afterCommit: () => ({ exit: true }),
  cancel: () => 'exit',
};

/** The move handle at `base` (plan-local) was grabbed: run the command until the pointer is released. */
export function beginPlanMove(base: Vec2): void {
  useViewerStore.getState().startCommand(PLAN_MOVE.id);
  if (getCommandRuntime().command?.id !== PLAN_MOVE.id) return;
  updateCommandGesture((g) => ({ ...(g as PlanMoveGesture), base }));
  window.addEventListener('pointerup', () => {
    const runtime = getCommandRuntime();
    if (runtime.command?.id !== PLAN_MOVE.id) return; // cancelled with Escape
    if (moved(runtime.gesture as PlanMoveGesture)) commitCommand();
    if (getCommandRuntime().command?.id === PLAN_MOVE.id) useViewerStore.getState().endCommand('cancel');
  }, { once: true });
}
