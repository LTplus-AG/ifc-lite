/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createAlignCommandBackend, type AlignGeometryProvider, type ModellingStoreModelResolver } from '@ifc-lite/sdk';
import { planBoxOf, storeyPlanFrame, roomFramePlanOffsets, roomFrameToModelWorld, toStoreyLocal, type PlanBox } from '@ifc-lite/create';
import { recordCompoundMutation, StoreEditor } from '@ifc-lite/mutations';
import { withHeadlessGeometry } from './headless-native-geometry.js';

export const provideHeadlessAlignGeometry: AlignGeometryProvider = (model, storeyId, ids) => withHeadlessGeometry(model, (source, meshes, coord) => {
    const plan = storeyPlanFrame(source, storeyId);
    if (!plan) throw new Error('Align storey placement is not a supported upright plane');
    const { cx, cy } = roomFramePlanOffsets(coord), { dx, dy } = roomFrameToModelWorld(coord);
    const boxes = new Map<number, PlanBox>();
    for (const id of ids) {
      const box = planBoxOf(meshes, id, { renderToLocal: ([x, y, z]) => {
        const [u, v] = toStoreyLocal(plan, [x + cx + dx, -z + cy + dy]);
        return [u, v, y];
      } });
      if (box) boxes.set(id, box);
    }
    return boxes;
  });

export function createHeadlessAlignBackend(resolve: ModellingStoreModelResolver) {
  return createAlignCommandBackend(resolve, provideHeadlessAlignGeometry, {
    historyHead: modelId => resolve(modelId).mutationView.getMutations().map(m => m.id).join('|'),
    record: (modelId, write) => {
      const model = resolve(modelId);
      return recordCompoundMutation(model.mutationView, mutationView => write({ ...model, mutationView, editor: new StoreEditor(model.store, mutationView) }));
    },
  });
}
