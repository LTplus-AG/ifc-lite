/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { AppearanceEntityPlan } from './planner-types.js';

export function validateAppearanceEntityPlan(editor: StoreEditor, view: MutablePropertyView, plan: AppearanceEntityPlan, currentRevision: string): void {
  if (plan.sourceRevision !== currentRevision || plan.nextExpressId !== view.peekNextExpressId()) {
    throw new Error('The model changed while preparing appearance. Refresh the preview.');
  }
  if (!plan.created.length && !plan.edits.length && !plan.removed.length) {
    throw new Error('The appearance plan contains no IFC edits.');
  }
  const createdIds = new Set<number>();
  for (const [index, entity] of plan.created.entries()) {
    if (!Number.isSafeInteger(entity.expressId) || entity.expressId !== plan.nextExpressId + index) {
      throw new Error('The appearance plan has inconsistent entity allocation.');
    }
    createdIds.add(entity.expressId);
  }
  const edited = new Set<string>();
  const removedIds = new Set(plan.removed);
  if (removedIds.size !== plan.removed.length) throw new Error('The appearance plan repeats an entity removal.');
  for (const edit of plan.edits) {
    const key = `${edit.expressId}:${edit.index}`;
    if ((!createdIds.has(edit.expressId) && !editor.hasEntity(edit.expressId))
      || edited.has(key) || removedIds.has(edit.expressId) || !Number.isSafeInteger(edit.index) || edit.index < 0) {
      throw new Error('The appearance plan contains conflicting attribute edits.');
    }
    edited.add(key);
  }
  for (const expressId of plan.removed) {
    if (!Number.isSafeInteger(expressId) || expressId <= 0 || createdIds.has(expressId) || view.isDeleted(expressId)) {
      throw new Error('The appearance plan contains an invalid entity removal.');
    }
  }
}
