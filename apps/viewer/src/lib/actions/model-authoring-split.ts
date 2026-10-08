/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { iterateEffectiveEntityIds, type StoreEditor } from '@ifc-lite/mutations';
import { splitElementsInStore, liveEntityConforms } from '@ifc-lite/create';
import type { IfcDataStore } from '@ifc-lite/parser';
import { readAttributes } from '@/lib/placement-edit';
import type { AuthoringOp, ModelAuthoringBatch } from './model-authoring';
import { readSplitSnapshot, sameSplitSnapshot } from './model-authoring-split-state';
import { splitCutInMetres } from './model-authoring-split-params';

type Split = Extract<AuthoringOp, { op: 'element.split' }>;

/** The generic resolver supplies model ownership. This native inventory
 * rejects malformed same-model GUID collisions before assigning effects. */
export function uniqueSplitGuid(store: IfcDataStore, editor: StoreEditor, guid: string): boolean {
  let hits = 0;
  const view = editor.getMutationView();
  const changed = new Set(view.getEffectiveChanges().map(change => change.entityId));
  for (const { expressId } of iterateEffectiveEntityIds(store, view)) {
    const native = changed.has(expressId) || view.getNewEntity(expressId)
      ? readAttributes(store, view, editor, expressId)?.[0] : store.entities.getGlobalId(expressId);
    // Only IfcRoot owns GlobalId: non-root attribute zero can be a Name.
    if (native === guid && liveEntityConforms(store, expressId, 'IfcRoot', view) && ++hits > 1) return false;
  }
  return hits === 1;
}

export function writeNativeSplit(batch: ModelAuthoringBatch, op: Split, store: IfcDataStore, editor: StoreEditor, id: number,
  scopes: Parameters<typeof splitElementsInStore>[3] = {}) {
  const current = readSplitSnapshot(store, editor, id, batch.units);
  if (!sameSplitSnapshot(current, op.expected)) throw new Error('The native split source differs from the expected shape or placement');
  return splitElementsInStore(store, editor, [{ expressId: id, cut: splitCutInMetres(op.cut, batch.units) }], scopes)[0];
}
