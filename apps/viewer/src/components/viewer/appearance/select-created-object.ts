/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
/** A newly authored object replaces all prior single/multi-model selections. */
export function selectCreatedAppearanceObject(modelId: string, result: { globalId: number; expressId: number }): void {
  const state = useViewerStore.getState(), ref = { modelId, expressId: result.expressId };
  state.selectAppearanceReference(null); state.clearEntitySelection();
  state.setSelectedEntityIds([result.globalId]); state.addEntityToSelection(ref); state.setSelectedEntity(ref);
}
