/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import type { Clash, ClashElementRef } from '@ifc-lite/clash';
import type { ClashFocusMode } from '@/store/slices/clashSlice';
import { toGlobalIdFromModels } from '@/store/globalId';

interface SelectionRef {
  modelId: string;
  expressId: number;
}

export interface FocusedClashGroup {
  selectedRefs: number[];
  aRefs: number[];
  bRefs: number[];
  modelIds: string[];
}

/** Focus the distinct objects in a manual group through the normal selection channel. */
export function focusClashGroup(
  clashes: readonly Clash[],
  resolve: (element: ClashElementRef) => SelectionRef | null,
  applyFocusMode: (globalIds: number[], mode: ClashFocusMode) => void,
  mode: ClashFocusMode,
): FocusedClashGroup | null {
  const state = useViewerStore.getState();
  const globalIds = new Set<number>();
  const selectionKeys = new Set<string>();
  const refs: SelectionRef[] = [];
  const aRefs = new Set<number>();
  const bRefs = new Set<number>();
  for (const clash of clashes) {
    for (const [side, element] of [['a', clash.a], ['b', clash.b]] as const) {
      const resolved = resolve(element);
      if (!resolved) continue;
      const globalId = toGlobalIdFromModels(state.models, resolved.modelId, resolved.expressId);
      globalIds.add(globalId);
      (side === 'a' ? aRefs : bRefs).add(globalId);
      const selectionKey = `${resolved.modelId}:${resolved.expressId}`;
      if (selectionKeys.has(selectionKey)) continue;
      selectionKeys.add(selectionKey);
      refs.push(resolved);
    }
  }
  if (refs.length === 0) return null;
  state.clearEntitySelection();
  state.clearClashFocus();
  state.setPendingColorUpdates(state.lensAppliedColors ?? new Map());
  state.setSelectedEntityIds([...globalIds]);
  state.addEntitiesToSelection(refs);
  applyFocusMode([...globalIds], mode);
  requestAnimationFrame(() => state.cameraCallbacks.frameSelection?.());
  // An object on both sides gets one deterministic color, never two.
  for (const ref of aRefs) bRefs.delete(ref);
  return {
    selectedRefs: [...globalIds],
    aRefs: [...aRefs],
    bRefs: [...bRefs],
    modelIds: [...new Set(refs.map(ref => ref.modelId))],
  };
}
