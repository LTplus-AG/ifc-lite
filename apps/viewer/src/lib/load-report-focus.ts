/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { buildLoadReport } from './loadReport';
/** UI and automation share the report's captured-geometry selection boundary. */
export function focusLoadReportEntity(modelId: string, expressId: number): boolean {
  const state = useViewerStore.getState(), model = state.models.get(modelId); if (!model) return false;
  const entity = buildLoadReport(model).affectedEntities.find(entity => entity.productId === expressId);
  if (!entity?.renderable) return false;
  // The row already names its model and product: select that pair directly, as the panel always did.
  state.setSelectedEntityIds([]); state.setSelectedEntityId(entity.globalId); state.setSelectedEntity({ modelId, expressId });
  if (state.cameraCallbacks.frameSelection) window.setTimeout(() => useViewerStore.getState().cameraCallbacks.frameSelection?.(), 50);
  return true;
}
