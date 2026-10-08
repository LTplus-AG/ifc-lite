/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Grid movement re-meshes placement dependents in their canonical frames
 * (#6232), and remembers the same history batch for Undo/Redo. */
import type { Mutation } from '@ifc-lite/mutations';
import type { ViewerState } from '@/store';
import { newMutationBatchId } from './mutation-batch-tags';
import { remeshAfterCommit } from '@/lib/remesh/remesh-registry';

export function remeshGridPlacementAfterCommit(
  get: () => ViewerState, modelId: string, expressId: number,
  mutation: Mutation | null, continuingBatch?: string,
): boolean {
  if (!mutation) return false;
  const state = get(), view = state.mutationViews.get(modelId);
  const type = view?.getEntityTypeMutation(expressId)?.newType
    ?? view?.getNewEntity(expressId)?.type
    ?? state.models.get(modelId)?.ifcDataStore?.entities.getTypeName(expressId);
  if (type?.toUpperCase() !== 'IFCGRID') return false;
  const batch = continuingBatch ?? newMutationBatchId();
  state.tagMutationBatch([mutation.id], batch);
  remeshAfterCommit(get, modelId, batch, [expressId], 'hostsChanged');
  return true;
}
