/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isGeometryHeld, type PickGatingState } from '@/lib/pick-gating';
import { useViewerStore } from '@/store';

const EMPTY_SELECTION = new Set<number>();

export function viewportSelection(
  state: PickGatingState,
  selectedId: number | null,
  selectedIds: Set<number>,
): { selectedId: number | null; selectedIds: Set<number> } {
  return isGeometryHeld(state) ? { selectedId: null, selectedIds: EMPTY_SELECTION } : { selectedId, selectedIds };
}

let pendingFrame: { duration: number | undefined; models: string[] } | null = null;
let subscribed = false;

export function deferSelectionFrameWhileHeld(duration: number | undefined): boolean {
  const state = useViewerStore.getState();
  if (!isGeometryHeld(state)) return false;
  const selectedModelId = state.selectedEntity?.modelId;
  const heldModels = [...state.models].filter(([, model]) => model.geometryRestorePending || model.loadState === 'streaming-geometry').map(([id]) => id);
  pendingFrame = { duration, models: selectedModelId ? [selectedModelId] : (heldModels.length ? heldModels : [...state.models.keys()]) };
  const releaseIfReady = (next: typeof state) => {
    if (!pendingFrame) return;
    const queued = pendingFrame;
    for (const id of queued.models) {
      const model = next.models.get(id);
      if (!model || model.loadState === 'error') { pendingFrame = null; return; }
      if (model.geometryRestorePending) return;
    }
    pendingFrame = null;
    next.cameraCallbacks.frameSelection?.(queued.duration);
  };
  if (!subscribed) {
    subscribed = true;
    useViewerStore.subscribe((next) => {
      releaseIfReady(next);
    });
  }
  releaseIfReady(state);
  return true;
}
