/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one way a Compare row selects things in 3D: replace the selection with
 * the row's entities, remember which row is focused (`compareSelectedKey`,
 * `null` for a whole-group click, which has no single "what changed" detail),
 * and frame the camera. Every row kind (entry, content match, suggestion) and
 * every group header goes through here, so they cannot drift apart.
 */

import { useViewerStore } from '@/store';
import type { CompareRef } from '@/lib/compare/buildFingerprints';

export function focusRefs(refs: readonly CompareRef[], selectedKey: string | null): void {
  if (refs.length === 0) return;
  const state = useViewerStore.getState();
  state.clearEntitySelection();
  state.setSelectedEntityIds(refs.map((r) => r.globalId));
  state.addEntitiesToSelection(refs.map((r) => ({ modelId: r.modelId, expressId: r.localId })));
  state.setCompareSelectedKey(selectedKey);
  requestAnimationFrame(() => state.cameraCallbacks.frameSelection?.());
}
