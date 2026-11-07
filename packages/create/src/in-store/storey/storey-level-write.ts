/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Write a planned storey re-level into a draft (#9013): placement lifts and
 * storey Elevation attributes. Callers own the atomic transaction; a throw
 * here means nothing is published.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreyLevelPlan } from './storey-level-plan.js';
import { writeShiftedPlacement } from './storey-placement.js';

/** Returns every product whose mesh the write changed beyond a pure move (none yet). */
export function writeStoreyLevelPlan(_store: IfcDataStore, draft: StoreEditor, plan: StoreyLevelPlan): number[] {
  for (const write of plan.placements) writeShiftedPlacement(draft, write.leaf, write.offset);
  for (const storey of plan.storeys) {
    draft.setPositionalAttribute(storey.expressId, 9, { real: Math.round(storey.elevationAttribute * 1e9) / 1e9 });
  }
  return [];
}
