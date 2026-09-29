/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Write a move or a turn of a selection inside ONE authoring transaction
 * (charter #6232, C2): the params → commit core both `element.move` and
 * `element.rotate` call, gesture-free, so a headless caller (SDK / MCP, D8)
 * can drive the same write.
 *
 * The op is given in RENDER space (what the user picked); each root is
 * written in its own storey's frame through that storey's workplane, then in
 * its parent placement's frame (`plan.ts`), with the existing store actions:
 * `translateEntity` for the origin, `rotateEntity` for the RefDirection. A
 * turn about a pivot is the two together: the placement turns about its own
 * origin, and the origin swings about the pivot.
 *
 * Wall joins (B2): walls joined to a moved wall must follow it. That lands
 * with the join network; until then `setTransformJoinCarrier` is the seam it
 * plugs into — called in the same transaction after the roots are written,
 * returning the extra elements it reshaped, which are re-meshed with the rest.
 */

import type { ViewerState } from '@/store';
import type { AuthoringTransaction, CommitResult, Vec3 } from '@/lib/commands/modeling/types';
import { buildStoreyWorkplane, elementStoreyId, isWorkplane } from '@/lib/commands/modeling/workplane';
import { planElementTransform, type TransformPlan, type TransformRefusal, type TransformRoot } from './plan.js';
import { rotateBy, unrotateBy } from './placement-frames.js';

type Vec2 = [number, number];

export type ElementTransformOp =
  | { readonly kind: 'move'; readonly from: Vec3; readonly to: Vec3 }
  /** `angle` in radians, counter-clockwise seen from above. */
  | { readonly kind: 'rotate'; readonly pivot: Vec3; readonly angle: number };

export interface JoinCarryContext {
  readonly tx: AuthoringTransaction;
  readonly modelId: string;
  readonly plan: TransformPlan;
  readonly op: ElementTransformOp;
}

/** Makes joined elements follow a move or turn; returns the ids it reshaped (to re-mesh). */
export type TransformJoinCarrier = (ctx: JoinCarryContext) => readonly number[];

let joinCarrier: TransformJoinCarrier | null = null;

/** Install the wall-join follower (B2). Returns the function that removes it. */
export function setTransformJoinCarrier(carrier: TransformJoinCarrier | null): () => void {
  const previous = joinCarrier;
  joinCarrier = carrier;
  return () => { joinCarrier = previous; };
}

/** Plan a transform of `selected` (model-local ids) as the store sees it now. */
export function planSelectionTransform(s: ViewerState, modelId: string, selected: readonly number[]): TransformPlan | null {
  const dataStore = s.models.get(modelId)?.ifcDataStore;
  const view = s.mutationViews.get(modelId);
  if (!dataStore || !view) return null;
  return planElementTransform({ dataStore, view, selected, storeyOf: (id) => elementStoreyId(s, modelId, id) });
}

export function describeRefusal(refusal: TransformRefusal): string {
  switch (refusal.reason) {
    case 'noStorey': return `#${refusal.expressId} is on no storey`;
    case 'noPlacement': return `#${refusal.expressId} has no placement`;
    default: return `#${refusal.expressId}'s placement does not hang from its storey`;
  }
}

const sub2 = (a: readonly number[], b: readonly number[]): Vec2 => [a[0] - b[0], a[1] - b[1]];

function storeyLocal(s: ViewerState, modelId: string, storeyId: number, cache: Map<number, (p: Vec3) => Vec2>): (p: Vec3) => Vec2 {
  let toLocal = cache.get(storeyId);
  if (!toLocal) {
    const plane = buildStoreyWorkplane(s, modelId, storeyId, 0);
    if (!isWorkplane(plane)) throw new Error(plane.refused);
    toLocal = (p) => { const l = plane.renderToLocal(p); return [l[0], l[1]]; };
    cache.set(storeyId, toLocal);
  }
  return toLocal;
}

/** The storey-frame delta of the root's origin, and the turn, for `op`. */
function rootStep(root: TransformRoot, op: ElementTransformOp, toLocal: (p: Vec3) => Vec2): { delta: Vec2; turn: number } {
  if (op.kind === 'move') return { delta: sub2(toLocal(op.to), toLocal(op.from)), turn: 0 };
  const pivot = toLocal(op.pivot);
  const swung = rotateBy([Math.cos(op.angle), Math.sin(op.angle)], sub2(root.origin, pivot));
  return { delta: [pivot[0] + swung[0] - root.origin[0], pivot[1] + swung[1] - root.origin[1]], turn: op.angle };
}

/**
 * Write `op` for `selected` of `modelId` in `tx`. Throws (so the transaction
 * reverts everything) when any element cannot be moved or turned.
 */
export function commitElementTransform(
  tx: AuthoringTransaction,
  modelId: string,
  selected: readonly number[],
  op: ElementTransformOp,
): CommitResult {
  const plan = planSelectionTransform(tx.store, modelId, selected);
  if (!plan) throw new Error('The model has no editable IFC data.');
  if (plan.refused.length > 0) throw new Error(`Can't move ${plan.refused.map(describeRefusal).join(', ')}.`);
  if (op.kind === 'rotate') {
    const tilted = plan.roots.find((r) => !r.upright);
    if (tilted) throw new Error(`#${tilted.expressId} is tilted; only upright elements turn about the vertical.`);
  }
  const planes = new Map<number, (p: Vec3) => Vec2>();
  for (const root of plan.roots) {
    const { delta, turn } = rootStep(root, op, storeyLocal(tx.store, modelId, root.storeyId, planes));
    const [dx, dy] = unrotateBy(root.parent.axis, delta);
    if (Math.hypot(dx, dy) > 1e-9) {
      const moved = tx.store.translateEntity(modelId, root.expressId, [dx, dy, 0], tx.batchId);
      if (!moved.ok) throw new Error(moved.reason);
    }
    if (turn !== 0) {
      const turned = tx.store.rotateEntity(modelId, root.expressId, turn);
      if (!turned.ok) throw new Error(turned.reason);
    }
  }
  const joined = joinCarrier?.({ tx, modelId, plan, op }) ?? [];
  const remesh = [...new Set([...plan.roots.map((r) => r.expressId), ...plan.carried, ...joined])];
  return { modelId, created: [], deleted: [], remesh, select: [...selected] };
}
