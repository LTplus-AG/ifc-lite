/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { readStoreyInventory } from './storey-model.js';
import { planStoreyLevelEdit, type StoreyLevelEdit, type StoreyLevelPlan } from './storey-level-plan.js';
import { writeStoreyLevelPlan } from './storey-level-write.js';
import { StoreyEditRefusedError } from './storey-validation.js';

const micro = (value: number): number => Math.round(value * 1e6);

/**
 * What makes two plans the same edit: where everything starts, the writes,
 * and which products they move or hold. A placement point moved or an axis
 * rotated after the review keeps the ids and offsets but changes where the
 * write lands (the fingerprint), and a product attached to a moved placement
 * changes the outcome without changing the writes, so both are part of it.
 */
export function storeyLevelPlanSignature(plan: StoreyLevelPlan): string {
  return JSON.stringify({
    moved: [...plan.moved].sort((x, y) => x - y),
    held: [...plan.held].sort((x, y) => x - y),
    storeys: plan.storeys.map(({ expressId, from, to, elevationAttribute }) => [expressId, micro(from), micro(to), micro(elevationAttribute)]),
    placements: plan.placements.map(({ leaf, offset }) => [
      leaf.placementId, leaf.parentId, leaf.axisPlacementId, leaf.location.map(micro), offset.map(micro),
    ]),
    // The floor-to-floor gaps as reviewed: a neighbour moved since changes them.
    spacing: plan.spacing.map(({ lowerId, upperId, from, to }) => [lowerId, upperId, micro(from), micro(to)]),
    fingerprint: plan.fingerprint,
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
    // A reviewed plan is answered first: what changed since the review is the news, not what the change now blocks.
    if (expected && storeyLevelPlanSignature(plan) !== storeyLevelPlanSignature(expected)) {
      throw new StoreyEditRefusedError([{ code: 'stale', message: 'The storey edit was planned against a model that has changed since; review it again' }]);
    }
    if (plan.refusals.length) throw new StoreyEditRefusedError(plan.refusals);
    return { plan, reshaped: writeStoreyLevelPlan(store, draft, plan) };
  });
}
