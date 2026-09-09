/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { modelIndices } from './model-indices.js';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { useViewerStore } from '@/store';
import { fromRenderTranslation, type Translation } from './translation.js';


export function modelBounds(modelId: string) {
  const state = useViewerStore.getState(), model = state.models.get(modelId);
  if (!model) return null;
  const handle = model.pointCloudHandleId === undefined ? undefined : { id: model.pointCloudHandleId };
  return getGlobalRenderer()?.getModelPlacementBounds(modelIndices(state.models).get(modelId) ?? 0, handle) ?? null;
}

export function modelCenter(modelId: string): Translation | null {
  const bounds = modelBounds(modelId);
  return bounds ? fromRenderTranslation({ x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2, z: (bounds.min.z + bounds.max.z) / 2 }) : null;
}

export function frameModels(ids: readonly string[]): void {
  const boxes = ids.map(modelBounds).filter((box) => box !== null);
  if (!boxes.length) throw new Error('Model bounds are not available yet.');
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const box of boxes) for (const axis of ['x', 'y', 'z'] as const) {
    min[axis] = Math.min(min[axis], box.min[axis]); max[axis] = Math.max(max[axis], box.max[axis]);
  }
  const renderer = getGlobalRenderer();
  renderer?.getCamera().fitToBounds(min, max);
  renderer?.requestRender();
}
