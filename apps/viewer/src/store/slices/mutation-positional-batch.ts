/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcAttributeValue, Mutation, PropertyValue, StoreEditor } from '@ifc-lite/mutations';

/**
 * Positional overrides written as ONE store update (#6232 perf).
 *
 * `setPositionalAttributesBatch` used to call `setPositionalAttribute` per
 * slot and tag the batch after: N + 1 store notifications for one edit (a
 * wall resize is four slots), each re-running every subscriber's selector.
 * The overlay writes happen here in order and the undo entries, redo reset,
 * dirty flag and batch tags land together through the caller's
 * `recordMutationBatch`. The entries are the same shape
 * `setPositionalAttribute` records, so undo and redo replay them unchanged.
 */
export function positionalMutations(
  editor: StoreEditor,
  modelId: string,
  updates: ReadonlyArray<{ entityId: number; index: number; value: IfcAttributeValue }>,
): Mutation[] {
  const view = editor.getMutationView();
  return updates.map(({ entityId, index, value }) => {
    const prior = view.getPositionalMutationsForEntity(entityId)?.get(index);
    editor.setPositionalAttribute(entityId, index, value);
    return {
      id: `mut_pos_${entityId}_${index}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      type: 'UPDATE_POSITIONAL_ATTRIBUTE',
      timestamp: Date.now(),
      modelId,
      entityId,
      attributeName: `@${index}`,
      oldValue: (prior ?? null) as PropertyValue,
      newValue: value as PropertyValue,
    };
  });
}
