/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `plan.move` (charter #6232, B3): drag the selected element by its move
 * handle in the plan. The handle is the base point; the cursor, through the
 * shared snap solver (tracking from the base), is the target. Release writes
 * one `translateEntity` in one transaction: one undo step, and the element
 * re-meshed with what it hosts (its openings, doors and windows follow it).
 *
 * Interim: C2's `element.move` (base point → target point, multi-selection,
 * carried hosted elements) is the move command. When it lands this command
 * goes and the plan's move handle starts `element.move` with the press as
 * its base and the release as its target.
 */

import { hostPlanFrame } from '@ifc-lite/create';
import { PlanMoveLayer } from '@/components/viewer/plan/PlanMoveLayer';
import { useViewerStore } from '@/store';
import type { ViewerState } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { expandAffectedSet } from '@/lib/remesh/affected-set';
import type { Vec2 } from '@/lib/snap/types';
import { commitCommand, getCommandRuntime, updateCommandGesture } from '../runtime.js';
import { buildStoreyWorkplane, elementStoreyId, isWorkplane } from '../workplane.js';
import type { CommandContext, ModelingCommand, Workplane } from '../types.js';

export interface PlanMoveTarget {
  readonly modelId: string;
  readonly expressId: number;
  readonly storeyId: number;
  /** The angle of the element's parent placement's X in its storey's plan, radians. */
  readonly parentAngle: number;
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
 * placement whose frame reaches that storey's, and a readable own rotation
 * (the parent frame the translation is written in follows from the two).
 */
export function readPlanMoveTarget(s: ViewerState, modelId: string, expressId: number): PlanMoveTarget | null {
  const dataStore = s.models.get(modelId)?.ifcDataStore;
  const storeyId = elementStoreyId(s, modelId, expressId);
  if (!dataStore || storeyId === null) return null;
  const frame = hostPlanFrame(dataStore, expressId, storeyId, s.mutationViews.get(modelId) ?? null);
  const own = frame ? s.readEntityRotation(modelId, expressId) : null;
  if (!frame || !own || s.readEntityPosition(modelId, expressId) === null) return null;
  return { modelId, expressId, storeyId, parentAngle: Math.atan2(frame.axisX[1], frame.axisX[0]) - own.yawZ };
}

/** The storey-frame move from `base` to `to` (workplane-local on `plane`), in the element's parent frame. */
function parentDelta(s: ViewerState, target: PlanMoveTarget, plane: Workplane, base: Vec2, to: Vec2): [number, number, number] {
  const storey = buildStoreyWorkplane(s, target.modelId, target.storeyId, 0);
  if (!isWorkplane(storey)) throw new Error(storey.refused);
  const local = (p: Vec2) => storey.renderToLocal(plane.localToRender([p[0], p[1], 0]));
  const a = local(base), b = local(to);
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const c = Math.cos(target.parentAngle), sn = Math.sin(target.parentAngle);
  return [dx * c + dy * sn, -dx * sn + dy * c, 0];
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
    const delta = parentDelta(tx.store, target, tx.workplane, base, to);
    const result = tx.store.translateEntity(target.modelId, target.expressId, delta, tx.batchId);
    if (!result.ok) throw new Error(result.reason);
    // What it hosts is placed relative to it: re-mesh those with it.
    const dataStore = tx.store.models.get(target.modelId)?.ifcDataStore;
    const view = tx.store.mutationViews.get(target.modelId) ?? null;
    const remesh = dataStore ? [...expandAffectedSet(dataStore, view, [target.expressId], 'hostsChanged')] : [target.expressId];
    return { modelId: target.modelId, created: [], deleted: [], remesh, select: [target.expressId] };
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
