/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ALIGN_MODES, alignMoves, type AlignMode, type PlanBox } from './align-boxes.js';
import { expandAffectedSet } from '@ifc-lite/export';
import { readWallJoinRels } from './wall-join-read.js';
import { effectiveStoreyId } from './edit/effective-storey.js';
import { planElementTransform } from './element-transform-plan.js';
import { transformElementsInStore, type ElementTransformInput, type ElementTransformResult } from './element-transform-edit.js';

export interface ElementAlignParams {
  readonly reference: number;
  readonly targets: readonly number[];
  readonly mode: AlignMode;
}

/** Bounds come from actual native/displayed meshes in one storey workplane.
 * The host owns the atomic transaction, renderer hooks and history record. */
export function alignElementsInStore(
  input: Omit<ElementTransformInput, 'selected' | 'op' | 'translationForElement'>,
  params: ElementAlignParams,
  boxes: ReadonlyMap<number, PlanBox>,
  toStoreyDelta?: (expressId: number, storeyId: number, shift: [number, number]) => [number, number],
): ElementTransformResult {
  alignmentStoreyInStore(input, params);
  for (const id of [params.reference, ...params.targets]) {
    const box = boxes.get(id);
    if (!box || ![...box.min, ...box.max, box.z0, box.z1].every(Number.isFinite)
      || box.min[0] > box.max[0] || box.min[1] > box.max[1] || box.z0 > box.z1) throw new Error(`Align requires current native geometry for #${id}`);
  }
  const plan = planElementTransform({ ...input, selected: params.targets, storeyOf: input.storeyOf ?? (id => effectiveStoreyId(input.dataStore, input.view, id) ?? null) });
  if (plan.carried.includes(params.reference)) throw new Error('The Align reference is hosted by a target and cannot stay fixed');
  // A selected host governs dependants below its placement: aligning the
  // child independently would move its cut twice or detach it from the host.
  const moves = alignMoves({ ...params, carried: plan.carried, boxes });
  if (moves.length === 0) throw new Error('The targets are already aligned');
  const selected = moves.map(move => move.id);
  const shifts = new Map<number, [number, number]>();
  for (const move of moves) {
    for (const id of expandAffectedSet(input.dataStore, input.view, [move.id], 'hostsChanged')) {
      if (id === params.reference) throw new Error('The Align reference would move with a target');
      const prior = shifts.get(id);
      if (prior && Math.hypot(prior[0] - move.shift[0], prior[1] - move.shift[1]) > 1e-4) throw new Error('Hosted Align targets require incompatible translations');
      shifts.set(id, move.shift);
    }
    shifts.set(move.id, move.shift);
  }
  for (const rel of readWallJoinRels(input.dataStore, input.view)) {
    const a = shifts.get(rel.relatingId), b = shifts.get(rel.relatedId);
    if ((a && rel.relatedId === params.reference) || (b && rel.relatingId === params.reference)) throw new Error('The Align reference is joined to a target');
    if (a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-4) throw new Error('Joined Align targets require incompatible translations');
  }
  return transformElementsInStore({ ...input, selected, op: { kind: 'move', delta: [0, 0] },
    translationForElement: (id, storeyId) => {
      const shift = shifts.get(id);
      if (!shift) throw new Error(`Align has no planned translation for #${id}`);
      return toStoreyDelta?.(id, storeyId, shift) ?? shift;
    },
  });
}

/** Shared preflight before expensive native geometry preparation. */
export function alignmentStoreyInStore(input: Pick<ElementTransformInput, 'dataStore' | 'view'>, params: ElementAlignParams): number {
  if (!ALIGN_MODES.includes(params.mode)) throw new Error('Unsupported Align mode');
  if (!Number.isSafeInteger(params.reference) || params.reference <= 0 || params.targets.length === 0 || params.targets.length > 10000
    || params.targets.some(id => !Number.isSafeInteger(id) || id <= 0 || id === params.reference)
    || new Set(params.targets).size !== params.targets.length) throw new Error('Align requires a reference and 1..10000 distinct targets');
  const storey = effectiveStoreyId(input.dataStore, input.view, params.reference);
  if (storey === undefined || params.targets.some(id => effectiveStoreyId(input.dataStore, input.view, id) !== storey)) {
    throw new Error('Align reference and targets must belong to one live storey');
  }
  return storey;
}
