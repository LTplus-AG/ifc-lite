/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore, type ViewerState } from '@/store';
import type { Clash, ClashElementRef } from '@ifc-lite/clash';
import type { ClashFocusMode } from '@/store/slices/clashSlice';
import { toGlobalIdFromModels } from '@/store/globalId';
import { resolveEntityRefGlobalIdFromState } from '@/store/resolveEntityRef';
import { CLASH_COLOR_A, CLASH_COLOR_B, type RGBA } from './clash-colors';

interface SelectionRef {
  modelId: string;
  expressId: number;
}

export interface FocusedClashGroup {
  /** Completes after the selected group has reached its final framed camera pose. */
  frameReady: Promise<void>;
  selectedRefs: SelectionRef[];
  aRefs: SelectionRef[];
  bRefs: SelectionRef[];
  selectedGuids: string[];
  aGuids: string[];
  bGuids: string[];
  modelIds: string[];
  sceneRevision: {
    modelRevisions: ReadonlyMap<string, object>;
    mutationVersion: number;
    hiddenEntities: ReadonlySet<number>;
    isolatedEntities: ReadonlySet<number> | null;
    ghostExceptEntities: ReadonlySet<number> | null;
    hiddenEntitiesByModel: ReadonlyMap<string, ReadonlySet<number>>;
    isolatedEntitiesByModel: ReadonlyMap<string, ReadonlySet<number>>;
    selectionRevision: number;
    clashHighlightColors: ViewerState['clashHighlightColors'];
    colorPresentationRevision: number;
  };
}

function resolvedGuids(state: ReturnType<typeof useViewerStore.getState>, refs: Iterable<SelectionRef>): string[] {
  const guids = new Set<string>();
  for (const ref of refs) {
    const guid = resolveEntityRefGlobalIdFromState(state, ref);
    if (guid) guids.add(guid);
  }
  return [...guids];
}

/** True while the models, authored IFC, and rendered visibility still match the focused frame. */
export function focusedSceneRevisionIsCurrent(focused: FocusedClashGroup): boolean {
  const state = useViewerStore.getState();
  const revision = focused.sceneRevision;
  if (state.models.size !== revision.modelRevisions.size) return false;
  for (const [modelId, model] of revision.modelRevisions) {
    if (state.models.get(modelId) !== model) return false;
  }
  return state.mutationVersion === revision.mutationVersion
    && state.hiddenEntities === revision.hiddenEntities
    && state.isolatedEntities === revision.isolatedEntities
    && state.ghostExceptEntities === revision.ghostExceptEntities
    && state.hiddenEntitiesByModel === revision.hiddenEntitiesByModel
    && state.isolatedEntitiesByModel === revision.isolatedEntitiesByModel
    && state.selectionRevision === revision.selectionRevision
    && state.clashHighlightColors === revision.clashHighlightColors
    && state.colorPresentationRevision === revision.colorPresentationRevision;
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
  const frameReady = new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      try {
        Promise.resolve(useViewerStore.getState().cameraCallbacks.frameSelection?.()).then(() => resolve(), (error) => {
          console.error('[clash] Could not finish framing the manual clash group:', error);
          resolve();
        });
      } catch (error) {
        console.error('[clash] Could not frame the manual clash group:', error);
        resolve();
      }
    });
  });
  // An object on both sides gets one deterministic color, never two.
  for (const key of aRefs.keys()) bRefs.delete(key);
  const a = [...aRefs.values()], b = [...bRefs.values()];
  const clashColors = new Map<number, RGBA>();
  for (const ref of a) {
    clashColors.set(toGlobalIdFromModels(state.models, ref.modelId, ref.expressId), CLASH_COLOR_A);
  }
  for (const ref of b) {
    const globalId = toGlobalIdFromModels(state.models, ref.modelId, ref.expressId);
    if (!clashColors.has(globalId)) clashColors.set(globalId, CLASH_COLOR_B);
  }
  const renderedARefs = [...a];
  const renderedBRefs: SelectionRef[] = [];
  for (const ref of b) {
    const globalId = toGlobalIdFromModels(state.models, ref.modelId, ref.expressId);
    (clashColors.get(globalId) === CLASH_COLOR_A ? renderedARefs : renderedBRefs).push(ref);
  }
  state.setClashHighlightColors(clashColors);
  state.setPendingColorUpdates(clashColors);
  const focusedState = useViewerStore.getState();
  return {
    frameReady,
    selectedRefs: refs,
    aRefs: a,
    bRefs: b,
    selectedGuids: resolvedGuids(state, refs),
    aGuids: resolvedGuids(state, renderedARefs),
    bGuids: resolvedGuids(state, renderedBRefs),
    modelIds: [...new Set(refs.map(ref => ref.modelId))],
    sceneRevision: {
      modelRevisions: new Map(focusedState.models),
      mutationVersion: focusedState.mutationVersion,
      hiddenEntities: focusedState.hiddenEntities,
      isolatedEntities: focusedState.isolatedEntities,
      ghostExceptEntities: focusedState.ghostExceptEntities,
      hiddenEntitiesByModel: focusedState.hiddenEntitiesByModel,
      isolatedEntitiesByModel: focusedState.isolatedEntitiesByModel,
      selectionRevision: focusedState.selectionRevision,
      clashHighlightColors: focusedState.clashHighlightColors,
      colorPresentationRevision: focusedState.colorPresentationRevision,
    },
  };
}
