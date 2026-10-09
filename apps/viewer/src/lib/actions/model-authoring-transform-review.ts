/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ViewerState } from '@/store';
import { buildStoreyWorkplane, elementStoreyId, isWorkplane } from '@/lib/commands/modeling/workplane';
import { planElementTransform, type TransformRoot } from '@/lib/element-transform/plan';
import { describeRefusal } from '@/lib/element-transform/commit';
import { placementAngle, type AuthoringReader } from './model-authoring-read';
import { toMetres, type AuthoringOp, type ModelAuthoringBatch } from './model-authoring';
import type { AuthoringRow } from './model-authoring-preview-types';
import { nativePlacementFromTarget, sameNativePlacement } from './model-authoring-placement';
import { AuthoringRefusal as Refusal } from './model-authoring-preview-refusal';
interface Context { state: ViewerState; batch: ModelAuthoringBatch; target: AuthoringReader }
const reader = (ctx: Context, _modelId: string) => ctx.target;
const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;
function transformRoot(ctx: Context, row: AuthoringRow, expressId: number): TransformRoot {
  const r = reader(ctx, row.modelId!);
  const plan = planElementTransform({ dataStore: r.dataStore, view: r.view, selected: [expressId],
    storeyOf: (id) => elementStoreyId(ctx.state, r.modelId, id) });
  if (plan.refused.length > 0) throw new Refusal('invalid', describeRefusal(plan.refused[0]));
  const root = plan.roots.find((candidate) => candidate.expressId === expressId);
  if (!root) throw new Refusal('invalid', 'The element moves with its host; move the host instead');
  const plane = buildStoreyWorkplane(ctx.state, r.modelId, root.storeyId, 0);
  if (!isWorkplane(plane)) throw new Refusal('unsupported', plane.refused);
  row.before.origin = [...root.origin];
  return root;
}

function checkMove(ctx: Context, op: Extract<AuthoringOp, { op: 'element.move' }>, root: TransformRoot): void {
  if (!op.from) return;
  const from = op.from.map((v) => toMetres(ctx.batch, v));
  if (!near(from[0], root.origin[0], 0.001) || !near(from[1], root.origin[1], 0.001)) {
    throw new Refusal('conflict', `Expected the element at (${op.from.join(', ')}); it is elsewhere now`);
  }
}

function checkTurn(ctx: Context, row: AuthoringRow, op: Extract<AuthoringOp, { op: 'element.rotate' }>, root: TransformRoot): void {
  if (op.expected && !sameNativePlacement(nativePlacementFromTarget(reader(ctx, row.modelId!), row.expressId!), op.expected)) throw new Refusal('conflict', 'The current native placement differs from the captured expected state');
  const angle = placementAngle(reader(ctx, row.modelId!), row.expressId!);
  if (!root.upright || !angle?.turnable) throw new Refusal('invalid', 'Its placement has no explicit reference direction to turn');
  const deg = angle.deg + (Math.atan2(root.parent.axis[1], root.parent.axis[0]) * 180) / Math.PI;
  row.before.angleDeg = deg;
  if (op.fromDeg !== undefined && !near(((op.fromDeg - deg) % 360 + 540) % 360 - 180, 0, 0.1)) {
    throw new Refusal('conflict', `Expected the element turned ${op.fromDeg}°; it is at ${deg.toFixed(1)}° now`);
  }
}

export function reviewElementTransform(state: ViewerState, target: AuthoringReader, batch: ModelAuthoringBatch, row: AuthoringRow): void {
  const ctx = { state, target, batch }, root = transformRoot(ctx, row, row.expressId!);
  if (row.op.op === 'element.move') checkMove(ctx, row.op, root);
  else if (row.op.op === 'element.rotate') checkTurn(ctx, row, row.op, root);
}
