/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { readStoreyInventory } from './storey-model.js';
import { planStoreyLevelEdit, type StoreyLevelEdit, type StoreyLevelPlan } from './storey-level-plan.js';
import { writeStoreyLevelPlan } from './storey-level-write.js';
import { StoreyEditRefusedError } from './storey-validation.js';

/**
 * What makes two plans the same edit: the writes, and which products they
 * move or hold. A product attached to a moved placement after the review
 * changes the outcome without changing the writes, so it is part of it.
 */
export function storeyLevelPlanSignature(plan: StoreyLevelPlan): string {
  return JSON.stringify({
    moved: [...plan.moved].sort((x, y) => x - y),
    held: [...plan.held].sort((x, y) => x - y),
    storeys: plan.storeys.map(({ expressId, to }) => [expressId, Math.round(to * 1e6)]),
    placements: plan.placements.map(({ leaf, offset }) => [leaf.placementId, leaf.axisPlacementId, offset.map((v) => Math.round(v * 1e6))]),
  });
}

export interface StoreyLevelResult {
  readonly plan: StoreyLevelPlan;
  /** Products whose shape changed, beyond a pure move. */
  readonly reshaped: readonly number[];
}

/**
 * Re-level a storey atomically: re-plan against the live overlay, refuse
 * (writing nothing) when the plan has a refusal or differs from `expected`,
 * otherwise write the placement lifts and storey Elevation attributes.
 * The caller records the one compound operation for Undo.
 */
export function applyStoreyLevelEdit(
  store: IfcDataStore, editor: StoreEditor, edit: StoreyLevelEdit, expected?: StoreyLevelPlan,
): StoreyLevelResult {
  return editor.runAtomic((draft) => {
    const plan = planStoreyLevelEdit(readStoreyInventory(store, draft.getMutationView()), edit);
    if (plan.refusals.length) throw new StoreyEditRefusedError(plan.refusals);
    if (expected && storeyLevelPlanSignature(plan) !== storeyLevelPlanSignature(expected)) {
      throw new Error('The storey edit was planned against a model that has changed since; review it again');
    }
    return { plan, reshaped: writeStoreyLevelPlan(store, draft, plan) };
  });
}
