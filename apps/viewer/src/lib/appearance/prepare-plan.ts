/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { EntityOperation, EntityPreparationOptions, IfcAttributeValue, MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { AppearanceEntityPlan } from './planner-types.js';
import type { AppliedAppearanceEntities } from './apply-plan.js';
import { validateAppearanceEntityPlan } from './validate-plan.js';

function yieldAppearanceTask(): Promise<void> {
  const host = globalThis as typeof globalThis & {
    scheduler?: { postTask(callback: () => void, options: { priority: 'background' }): Promise<void> };
  };
  // A fresh background task lets pending interaction run ahead of preparation.
  // scheduler.yield() continuations can retain the initiating input priority.
  return typeof host.scheduler?.postTask === 'function'
    ? host.scheduler.postTask(() => undefined, { priority: 'background' })
    : new Promise(resolve => setTimeout(resolve, 0));
}

/** Only owned records leave the mutations preparer; no draft view escapes. */
export async function prepareAppearanceEntities(
  editor: StoreEditor, view: MutablePropertyView, plan: AppearanceEntityPlan,
  currentRevision: string, options: EntityPreparationOptions,
) {
  validateAppearanceEntityPlan(editor, view, plan, currentRevision);
  const operations: EntityOperation[] = [
    ...plan.created.map(entity => ({ kind: 'create' as const, ...entity })),
    ...plan.edits.map(edit => ({ kind: 'setPositionalAttribute' as const, ...edit })),
    ...plan.removed.map(expressId => ({ kind: 'remove' as const, expressId })),
  ];
  const prepared = await prepareAppearanceOperationSequence(editor, operations, options);
  const applied: AppliedAppearanceEntities = {
    created: prepared.effects.flatMap(effect => effect.kind === 'create' ? [effect.entity] : []),
    removed: prepared.effects.flatMap(effect => effect.kind === 'remove' ? [{ expressId: effect.expressId, entity: effect.entity }] : []),
    before: prepared.effects.flatMap(effect => effect.kind === 'setPositionalAttribute'
      ? [{ expressId: effect.expressId, index: effect.index, present: effect.present, value: effect.value ?? null }] : []),
    // These are the preparer's detached history values, never caller plan aliases.
    after: prepared.mutations.flatMap(mutation => mutation.type === 'UPDATE_POSITIONAL_ATTRIBUTE'
      ? [{ expressId: mutation.entityId, index: Number(mutation.attributeName!.slice(1)), value: mutation.newValue as IfcAttributeValue }] : []),
    mutations: prepared.mutations,
  };
  return { prepared, applied };
}

/** Shared cooperative preparation budget for single and coordinated commands. */
export function prepareAppearanceOperationSequence(editor: StoreEditor, operations: readonly EntityOperation[], options: EntityPreparationOptions) {
  return editor.prepareEntityOperations(operations, {
    maxBytes: 2 * 1024 * 1024 * 1024, maxWork: 32_000_000,
    yieldTask: yieldAppearanceTask, ...options,
  });
}
