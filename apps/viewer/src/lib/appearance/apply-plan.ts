/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IfcAttributeValue, MutablePropertyView, Mutation, NewEntity, StoreEditor } from '@ifc-lite/mutations';
import { validateAppearanceEntityPlan } from './validate-plan.js';
import type { AppearanceEntityPlan } from './planner-types.js';
interface PreviousAttribute {
  expressId: number;
  index: number;
  present: boolean;
  value: IfcAttributeValue;
}
export interface AppliedAppearanceEntities {
  readonly created: readonly NewEntity[];
  readonly removed: ReadonlyArray<{ expressId: number; entity: NewEntity | null }>;
  readonly before: readonly PreviousAttribute[];
  readonly after: AppearanceEntityPlan['edits'];
  /** Real domain history records; the viewer groups this edit under its final record. */
  readonly mutations: readonly Mutation[];
}

/** Prepare asynchronous assets/GPU previews first, then commit these synchronous edits (#4243). */
export function applyAppearanceEntities(
  editor: StoreEditor,
  view: MutablePropertyView,
  plan: AppearanceEntityPlan,
  currentRevision: string,
): AppliedAppearanceEntities {
  return applyAppearanceEntitiesUsing(editor, view, plan, currentRevision, edit => editor.runAtomic(edit));
}

function applyAppearanceEntitiesUsing(
  editor: StoreEditor,
  view: MutablePropertyView,
  plan: AppearanceEntityPlan,
  currentRevision: string,
  mutate: (edit: (draft: StoreEditor) => void) => void,
): AppliedAppearanceEntities {
  validateAppearanceEntityPlan(editor, view, plan, currentRevision);
  const before = plan.edits.map(edit => {
    const values = view.getPositionalMutationsForEntity(edit.expressId);
    return { expressId: edit.expressId, index: edit.index,
      present: values?.has(edit.index) ?? false, value: structuredClone(values?.get(edit.index) ?? null) };
  });
  const removed = plan.removed.map(expressId => ({ expressId, entity: structuredClone(editor.getNewEntity(expressId)) }));
  const oldHistory = new Set(view.getMutations().map(mutation => mutation.id));
  mutate(draft => {
    for (const entity of plan.created) {
      const result = draft.addEntity(entity.type, structuredClone(entity.attributes));
      if (result.expressId !== entity.expressId) throw new Error('Appearance entity allocation changed.');
    }
    for (const edit of plan.edits) draft.setPositionalAttribute(edit.expressId, edit.index, structuredClone(edit.value));
    for (const { expressId } of removed) {
      if (!draft.removeEntity(expressId)) throw new Error(`Cannot replace missing IFC entity #${expressId}.`);
    }
  });
  return {
    created: plan.created.map(entity => structuredClone(editor.getNewEntity(entity.expressId)!)),
    removed, before, after: structuredClone(plan.edits),
    mutations: structuredClone(view.getMutations().filter(mutation => !oldHistory.has(mutation.id))),
  };
}

/** Called only when this command is at the top of the model's existing history stack. */
export function replayAppearanceEntities(
  view: MutablePropertyView,
  edit: AppliedAppearanceEntities,
  direction: 'undo' | 'redo',
): void {
  view.runAtomic(draft => replayAppearanceEntitiesInDraft(draft, edit, direction));
}

/** Internal command composition under the caller's detached transaction. */
export function replayAppearanceEntitiesInDraft(
  draft: MutablePropertyView,
  edit: AppliedAppearanceEntities,
  direction: 'undo' | 'redo',
): void {
  if (direction === 'undo') {
    for (const entity of [...edit.created].reverse()) draft.deleteEntity(entity.expressId);
    for (const removed of edit.removed) {
      if (removed.entity) draft.restoreNewEntity(structuredClone(removed.entity));
      else draft.restoreFromTombstone(removed.expressId);
    }
    for (const previous of edit.before) {
      if (previous.present) draft.setPositionalAttribute(previous.expressId, previous.index, structuredClone(previous.value), true);
      else draft.removePositionalMutation(previous.expressId, previous.index);
    }
  } else {
    for (const entity of edit.created) draft.restoreNewEntity(structuredClone(entity));
    for (const after of edit.after) draft.setPositionalAttribute(after.expressId, after.index, structuredClone(after.value), true);
    for (const removed of edit.removed) draft.deleteEntity(removed.expressId);
  }
}
