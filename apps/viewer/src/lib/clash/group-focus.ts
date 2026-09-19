/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import type { Clash, ClashElementRef } from '@ifc-lite/clash';
import type { ClashFocusMode } from '@/store/slices/clashSlice';
import { toGlobalIdFromModels } from '@/store/globalId';
import { resolveEntityRefGlobalIdFromState } from '@/store/resolveEntityRef';

interface SelectionRef {
  modelId: string;
  expressId: number;
}

export interface FocusedClashGroup {
  selectedRefs: SelectionRef[];
  aRefs: SelectionRef[];
  bRefs: SelectionRef[];
  selectedGuids: string[];
  aGuids: string[];
  bGuids: string[];
  modelIds: string[];
}

function resolvedGuids(state: ReturnType<typeof useViewerStore.getState>, refs: Iterable<SelectionRef>): string[] {
  const guids = new Set<string>();
  for (const ref of refs) {
    const guid = resolveEntityRefGlobalIdFromState(state, ref);
    if (guid) guids.add(guid);
  }
  return [...guids];
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
  const aRefs = new Map<string, SelectionRef>();
  const bRefs = new Map<string, SelectionRef>();
  for (const clash of clashes) {
    for (const [side, element] of [['a', clash.a], ['b', clash.b]] as const) {
      const resolved = resolve(element);
      if (!resolved) continue;
      const globalId = toGlobalIdFromModels(state.models, resolved.modelId, resolved.expressId);
      globalIds.add(globalId);
      const selectionKey = `${resolved.modelId}:${resolved.expressId}`;
      const sideRefs = side === 'a' ? aRefs : bRefs;
      if (!sideRefs.has(selectionKey)) sideRefs.set(selectionKey, resolved);
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
  for (const key of aRefs.keys()) bRefs.delete(key);
  const a = [...aRefs.values()], b = [...bRefs.values()];
  return {
    selectedRefs: refs,
    aRefs: a,
    bRefs: b,
    selectedGuids: resolvedGuids(state, refs),
    aGuids: resolvedGuids(state, a),
    bGuids: resolvedGuids(state, b),
    modelIds: [...new Set(refs.map(ref => ref.modelId))],
  };
}
