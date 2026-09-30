/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';

/** Select and frame an edited element, from the Changes and Change sets panels. */
export function selectChangedEntity(modelId: string, entityId: number): void {
  const state = useViewerStore.getState();
  const globalId = state.toGlobalId(modelId, entityId);
  const ref = resolveEntityRef(globalId);
  // A removed or replaced model may reuse an old express id. Do not select
  // an unrelated entity just because its renderer-space number now matches.
  if (ref.modelId !== modelId || ref.expressId !== entityId) return;
  state.setSelectedEntityIds([]);
  state.setSelectedEntityId(globalId);
  state.setSelectedEntity(ref);
  if (state.cameraCallbacks.frameSelection) {
    window.setTimeout(() => useViewerStore.getState().cameraCallbacks.frameSelection?.(), 50);
  }
}
