/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import type { EntityRefLike } from './cost-tree';
/** One two-channel selection handler for Cost detail actions and automation. */
export function selectCostTargets(refs: EntityRefLike[]): void {
  if (!refs.length) return;
  const s = useViewerStore.getState();
  const ids = refs.map(ref => s.toGlobalId(ref.modelId, ref.expressId));
  s.clearEntitySelection(); s.setSelectedEntityIds(ids); s.setSelectedEntityId(ids[0]);
  s.addEntitiesToSelection(refs); s.setSelectedEntities(refs);
  if (s.cameraCallbacks.frameSelection) window.setTimeout(() => useViewerStore.getState().cameraCallbacks.frameSelection?.(), 50);
}
