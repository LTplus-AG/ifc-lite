/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Mutation } from '@ifc-lite/mutations';
import { readStoreyInventory, readTopAttachment } from '@ifc-lite/create';
import { setProductPosition } from '@/lib/placement-edit';
import { remeshAfterCommit } from '@/lib/remesh/remesh-registry';
import { modelEditTarget, recordModellingEdit, type ModellingStore } from './mutation-modelling-records';
import { prepareWallRoomUpdate } from './mutation-placement-rooms';
/** `mutation` is one entry of the committed batch, for the room's record of the move. */
type Outcome = { ok: true; newCoordinates: [number, number, number]; mutation?: Mutation } | { ok: false; reason: string };
/** Roof/slab moves and their attached tops are one reversible edit, including gizmo batches. */
export function moveAttachedTargetIn(store: ModellingStore, modelId: string, id: number, native: [number, number, number], batchId?: string): Outcome | null {
  const target = modelEditTarget(store.getState(), modelId);
  if (!target) return null;
  const type = target.editor.getEntityType(id)?.toUpperCase() ?? '';
  // A slab-bound element refits its own top; a storey-bound one keeps the plain move.
  const attached = typeof target.view.getPropertyValue(id, 'IfcLite_StoreyAttachment', 'TopConstraint') === 'string'
    && readTopAttachment(readStoreyInventory(target.dataStore, target.view), id)?.targetElementId !== undefined;
  if (!/^(IFCROOF|IFCSLAB|IFCSLABSTANDARDCASE|IFCSLABELEMENTEDCASE)$/.test(type) && !attached) return null;
  const rooms = type.startsWith('IFCWALL') && attached ? prepareWallRoomUpdate(store, modelId, id) : null;
  try {
    const result = recordModellingEdit(store, modelId, (_methods, draft) => {
      const update = rooms?.(draft);
      const result = setProductPosition(target.dataStore, draft.getMutationView(), draft, id, native);
      if (!result.ok) throw new Error(result.reason);
      return { ...result, rooms: update ? update() : [] };
    }, batchId);
    const undo = store.getState().undoStacks.get(modelId)?.at(-1);
    const batch = undo ? store.getState().mutationBatchTags.get(undo.id) ?? null : null;
    remeshAfterCommit(store.getState, modelId, batch, [id, ...(result.remesh ?? []), ...result.rooms], 'shape');
    return { ok: true, newCoordinates: native, mutation: undo };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
}
