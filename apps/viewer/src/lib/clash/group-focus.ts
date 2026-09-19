/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import type { Clash, ClashElementRef } from '@ifc-lite/clash';
import type { ClashFocusMode } from '@/store/slices/clashSlice';

interface SelectionRef {
  modelId: string;
  expressId: number;
}

/** Focus the distinct objects in a manual group through the normal selection channel. */
export function focusClashGroup(
  clashes: readonly Clash[],
  resolve: (element: ClashElementRef) => SelectionRef | null,
  applyFocusMode: (globalIds: number[], mode: ClashFocusMode) => void,
  mode: ClashFocusMode,
): void {
  const state = useViewerStore.getState();
  const globalIds = new Set<number>();
  const refs: SelectionRef[] = [];
  for (const clash of clashes) {
    for (const element of [clash.a, clash.b]) {
      const resolved = resolve(element);
      if (!resolved || globalIds.has(element.ref)) continue;
      globalIds.add(element.ref);
      refs.push(resolved);
    }
  }
  if (globalIds.size === 0) return;
  state.clearEntitySelection();
  state.clearClashFocus();
  state.setPendingColorUpdates(state.lensAppliedColors ?? new Map());
  state.setSelectedEntityIds([...globalIds]);
  state.addEntitiesToSelection(refs);
  applyFocusMode([...globalIds], mode);
  requestAnimationFrame(() => state.cameraCallbacks.frameSelection?.());
}
