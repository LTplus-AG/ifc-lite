/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { planBoxOf, type PlanBox } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import { modelMeshes } from '@/lib/commands/modeling/align-boxes';
import { toGlobalIdFromModels } from '@/store/globalId';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { requestRemesh } from '@/lib/remesh/remesh-service';

/** The existing SDK Align geometry preparation, shared with reviewed Align.
 * Native preparation owns the fresh meshes; callers retain source leases. */
export async function prepareNativeAlignmentGeometry(get: () => ViewerState, modelId: string, storeyId: number, ids: readonly number[]) {
  const native = await requestRemesh(get, modelId, ids, 'shape');
  if (native.status !== 'applied') throw new Error(`Align native geometry preparation ${native.status}; retry after the model finishes updating`);
  const state = get(), plane = buildStoreyWorkplane(state, modelId, storeyId, 0);
  if (!isWorkplane(plane)) throw new Error(plane.refused);
  const boxes = new Map<number, PlanBox>();
  for (const id of ids) {
    const box = planBoxOf(modelMeshes(state, modelId), toGlobalIdFromModels(state.models, modelId, id), plane);
    if (box) boxes.set(id, box);
  }
  return { boxes, plane };
}
