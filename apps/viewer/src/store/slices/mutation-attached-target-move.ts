/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { setProductPosition } from '@/lib/placement-edit';
import { remeshAfterCommit } from '@/lib/remesh/remesh-registry';
import { modelEditTarget, recordModellingEdit, type ModellingStore } from './mutation-modelling-records';
type Outcome = { ok: true; newCoordinates: [number, number, number] } | { ok: false; reason: string };
/** Roof/slab moves and their attached tops are one reversible edit, including gizmo batches. */
export function moveAttachedTargetIn(store: ModellingStore, modelId: string, id: number, native: [number, number, number], batchId?: string): Outcome | null {
  const target = modelEditTarget(store.getState(), modelId);
  if (!target) return null;
  const type = target.editor.getEntityType(id)?.toUpperCase() ?? '';
  const wall = /^IFCWALL/.test(type) && typeof target.view.getPropertyValue(id, 'IfcLite_StoreyAttachment', 'TopConstraint') === 'string';
  if (!/^(IFCROOF|IFCSLAB|IFCSLABSTANDARDCASE|IFCSLABELEMENTEDCASE)$/.test(type) && !wall) return null;
  try {
    const result = recordModellingEdit(store, modelId, (_methods, draft) => {
      const result = setProductPosition(target.dataStore, draft.getMutationView(), draft, id, native);
      if (!result.ok) throw new Error(result.reason);
      return result;
    }, batchId);
    const undo = store.getState().undoStacks.get(modelId)?.at(-1);
    const batch = undo ? store.getState().mutationBatchTags.get(undo.id) ?? null : null;
    remeshAfterCommit(store.getState, modelId, batch, [id, ...(result.remesh ?? [])], 'shape');
    return { ok: true, newCoordinates: native };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
}
