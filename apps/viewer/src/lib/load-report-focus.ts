/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { buildLoadReport } from './loadReport';
/** UI and automation share the report's captured-geometry selection boundary. */
export function focusLoadReportEntity(modelId: string, expressId: number): boolean {
  const state = useViewerStore.getState(), model = state.models.get(modelId); if (!model) return false;
  const entity = buildLoadReport(model).affectedEntities.find(entity => entity.productId === expressId);
  if (!entity?.renderable) return false;
  const ref = resolveEntityRef(entity.globalId); if (ref.modelId !== modelId || ref.expressId !== expressId) return false;
  state.setSelectedEntityIds([]); state.setSelectedEntityId(entity.globalId); state.setSelectedEntity(ref);
  if (state.cameraCallbacks.frameSelection) window.setTimeout(() => useViewerStore.getState().cameraCallbacks.frameSelection?.(), 50);
  return true;
}
