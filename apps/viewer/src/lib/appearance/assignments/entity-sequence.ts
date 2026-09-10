/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { EntityOperation, EntityOperationEffect, EntityPreparationOptions, IfcAttributeValue, MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { AppearancePlan } from '../planner-types.js';
import { prepareAppearanceOperationSequence } from '../prepare-plan.js';

/** Preserve operation order, including repeated edits to a shared IFC resource.
 * Every plan was validated against the previous detached state by preparation. */
export async function prepareAppearanceEntitySequence(editor: StoreEditor, view: MutablePropertyView,
  plans: readonly AppearancePlan[], revision: string, options: EntityPreparationOptions) {
  if (!plans.length) throw new Error('The appearance sequence contains no native plans.');
  let watermark = view.peekNextExpressId();
  const operations: EntityOperation[] = [];
  for (const plan of plans) {
    if (plan.sourceRevision !== revision || plan.nextExpressId !== watermark
      || plan.nextAvailableExpressId !== plan.nextExpressId + plan.created.length) throw new Error('The appearance sequence allocation or revision changed.');
    for (const entity of plan.created) operations.push({ kind: 'create', ...entity });
    for (const edit of plan.edits) operations.push({ kind: 'setPositionalAttribute', ...edit });
    for (const expressId of plan.removed) operations.push({ kind: 'remove', expressId });
    watermark = plan.nextAvailableExpressId;
  }
  const prepared = await prepareAppearanceOperationSequence(editor, operations, options);
  try {
    const updates = prepared.mutations.filter(mutation => mutation.type === 'UPDATE_POSITIONAL_ATTRIBUTE');
    let index = 0;
    const records = prepared.effects.map(effect => {
      if (effect.kind !== 'setPositionalAttribute') return { effect };
      const mutation = updates[index++];
      if (!mutation || mutation.entityId !== effect.expressId || mutation.attributeName !== `@${effect.index}`) throw new Error('Appearance replay records do not match the prepared edits.');
      return { effect, after: mutation.newValue as IfcAttributeValue };
    });
    if (index !== updates.length) throw new Error('Appearance replay contains unmatched positional edits.');
    return { prepared, mutations: prepared.mutations,
      created: prepared.effects.flatMap(effect => effect.kind === 'create' ? [effect.entity] : []),
      references: prepared.effects.flatMap(effect => effect.kind === 'create' ? effect.entity.attributes
        : effect.kind === 'setPositionalAttribute' ? [effect.value ?? null]
          : [`#${effect.expressId}`, ...(effect.entity?.attributes ?? [])]),
      replay(draft: MutablePropertyView, direction: 'undo' | 'redo') {
        const ordered = direction === 'undo' ? [...records].reverse() : records;
        for (const record of ordered) replayEffect(draft, record.effect, record.after, direction);
      },
    };
  } catch (error) { prepared.dispose(); throw error; }
}
function replayEffect(view: MutablePropertyView, effect: EntityOperationEffect, after: IfcAttributeValue | undefined, direction: 'undo' | 'redo') {
  if (effect.kind === 'create') {
    if (direction === 'undo') view.deleteEntity(effect.entity.expressId);
    else view.restoreNewEntity(structuredClone(effect.entity));
  } else if (effect.kind === 'remove') {
    if (direction === 'redo') view.deleteEntity(effect.expressId);
    else if (effect.entity) view.restoreNewEntity(structuredClone(effect.entity));
    else view.restoreFromTombstone(effect.expressId);
  } else if (direction === 'redo') view.setPositionalAttribute(effect.expressId, effect.index, structuredClone(after ?? null), true);
  else if (effect.present) view.setPositionalAttribute(effect.expressId, effect.index, structuredClone(effect.value ?? null), true);
  else view.removePositionalMutation(effect.expressId, effect.index);
}
