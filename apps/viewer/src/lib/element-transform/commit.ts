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
 * Wall joins (B2): walls joined to a moved wall follow it. The join carrier
 * (`wall-join-carrier.ts`) runs in the same transaction after the roots are
 * written and returns the extra elements it reshaped, which are re-meshed with
 * the rest. `setTransformJoinCarrier` replaces it (tests, other join models).
 */

import type { ViewerState } from '@/store';
import type { AuthoringTransaction, CommitResult, Vec3 } from '@/lib/commands/modeling/types';
import { buildStoreyWorkplane, elementStoreyId, isWorkplane } from '@/lib/commands/modeling/workplane';
import { planElementTransform, type TransformPlan } from './plan.js';
import { transformElementsInStore, describeTransformRefusal } from '../../../../../packages/create/src/in-store/element-transform-edit.js';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { carryWallJoins } from './wall-join-carrier.js';

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

let joinCarrier: TransformJoinCarrier | null = carryWallJoins;

/** Replace the wall-join follower (B2); `null` turns it off. Returns the function that restores the previous one. */
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

export const describeRefusal = describeTransformRefusal;

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
  const target = modelEditTarget(tx.store, modelId);
  if (!target) throw new Error('The model has no editable IFC data.');
  const planes = new Map<number, (p: Vec3) => Vec2>();
  const result = transformElementsInStore({
    ...target, selected,
    op: op.kind === 'move' ? { kind: 'move', delta: [0, 0] } : { kind: 'rotate', pivot: [0, 0], angle: op.angle },
    storeyOf: id => elementStoreyId(tx.store, modelId, id),
    operationForStorey: storeyId => {
      const toLocal = storeyLocal(tx.store, modelId, storeyId, planes);
      return op.kind === 'move' ? { kind: 'move', delta: sub2(toLocal(op.to), toLocal(op.from)) }
        : { kind: 'rotate', pivot: toLocal(op.pivot), angle: op.angle };
    },
    translate: (id, delta) => {
      const moved = tx.store.translateEntity(modelId, id, delta, tx.batchId);
      if (!moved.ok) throw new Error(moved.reason);
    },
    rotate: (id, angle) => {
      const turned = tx.store.rotateEntity(modelId, id, angle);
      if (!turned.ok) throw new Error(turned.reason);
    },
    carryJoins: plan => joinCarrier?.({ tx, modelId, plan, op }) ?? [],
  });
  return { modelId, created: [], deleted: [], remesh: result.remesh,
    ...(result.hostsChanged ? { remeshCause: 'hostsChanged' as const } : {}), select: [...selected] };
}
