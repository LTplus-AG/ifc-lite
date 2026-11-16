/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { clashElementCache } from '@/lib/clash/element-cache';
import { useViewerStore } from '@/store';
import type { ClashFocusMode } from '@/store/slices/clashSlice';
import { type Clash, type ClashElement, type ClashElementRef } from '@ifc-lite/clash';
import { contactClusters } from '@ifc-lite/clash/contact';
import { buildClashPairColors, CLASH_COLOR_A } from '@/lib/clash/clash-colors';
import { clashFramingBounds } from '@/lib/clash/clash-framing';
import { contactLineList } from '@/lib/clash/contact-lines';
import { computeClashIntersectionSolid } from '@/lib/clash/intersection-solid';
import { restoreOverridesForGhosting } from '@/lib/clash/ghost-color-overrides';
import { focusClashGroup } from '@/lib/clash/group-focus';
import { clashRefModelIsCurrent } from '@/lib/clash/federation-identity';
interface SelectionRef {
  modelId: string;
  expressId: number;
}
export const CLASH_SUPERSEDED_MESSAGE =
  'The model data was replaced since this clash run, so these results no longer match it. Re-run detection.';
export const CLASH_MODEL_UNLOADED_MESSAGE =
  'A model these clash results reference is no longer loaded, so its rows cannot be opened. Load it again, or re-run detection.';
export const CLASH_REF_UNRESOLVED_MESSAGE =
  'Some clash rows reference elements that are no longer in the model they were found in, so those rows cannot be opened.';
export function createClashFocus(options: {
  installClashIsolation: (ids: Set<number>) => void;
  installClashGhost: (ids: Set<number>) => void;
}) {
  const { installClashIsolation, installClashGhost } = options;
  const elementsByIdentity = clashElementCache;
  const elementIdentity = (e: Pick<ClashElement, 'model' | 'key'>) => JSON.stringify([e.model, e.key]);
  const refOf = (ref: ClashElementRef): SelectionRef | null => {
    const state = useViewerStore.getState();
    const loaded = state.models.has(ref.model);
    if (!clashRefModelIsCurrent(state.clashRawResult, ref.model, state.models)) {
      const message = loaded ? CLASH_SUPERSEDED_MESSAGE : CLASH_MODEL_UNLOADED_MESSAGE;
      if (state.clashError !== message) state.setClashError(message);
      return null;
    }
    if (loaded) {
      const resolved = state.resolveGlobalIdInModel(ref.model, ref.ref);
      if (!resolved && state.clashError !== CLASH_REF_UNRESOLVED_MESSAGE) {
        state.setClashError(CLASH_REF_UNRESOLVED_MESSAGE);
      }
      return resolved;
    }
    return state.fromGlobalId(ref.ref);
  };
  const applyFocusMode = (globalIds: number[], mode: ClashFocusMode): void => {
    if (mode === 'isolate') installClashIsolation(new Set(globalIds));
    else if (mode === 'ghost') installClashGhost(new Set(globalIds));
    else {
      const state = useViewerStore.getState();
      state.clearIsolation();
      state.clearGhost();
      state.setClashVisibilityOwned(null);
    }
  };
  const focusClashes = (clashes: readonly Clash[], mode: ClashFocusMode = 'highlight') =>
    focusClashGroup(clashes, refOf, applyFocusMode, mode);
  const focusClash = (clash: Clash, mode: ClashFocusMode = 'highlight'): void => {
    const state = useViewerStore.getState();
    const a = refOf(clash.a);
    const b = refOf(clash.b);
    const refs = [a, b].filter((r): r is SelectionRef => r !== null);
    if (refs.length === 0) return;
    const globalIds: number[] = [];
    if (a) globalIds.push(clash.a.ref);
    if (b) globalIds.push(clash.b.ref);
    state.clearEntitySelection();
    state.setSelectedEntityIds([...globalIds].reverse());
    state.addEntitiesToSelection([...refs].reverse());
    const colors = buildClashPairColors(a ? clash.a.ref : null, b ? clash.b.ref : null);
    state.setClashHighlightColors(colors);
    state.setPendingColorUpdates(colors);
    let contactDrawn = false;
    const elA = elementsByIdentity.current.get(elementIdentity(clash.a));
    const elB = elementsByIdentity.current.get(elementIdentity(clash.b));
    if (elA && elB) {
      try {
        const clusters = contactClusters(
          { id: elA.key, positions: elA.positions, indices: elA.indices },
          { id: elB.key, positions: elB.positions, indices: elB.indices },
          { epsilon: Math.max(state.clashTolerance, 0.002) },
        );
        const vertices = contactLineList(clusters);
        if (vertices.length >= 6) {
          state.setClashContactLines({ vertices });
          state.setClashOverlapBox(null);
          contactDrawn = true;
        }
      } catch (error) {
        console.warn('[clash] Contact interface unavailable; displaying native overlap bounds.', error);
      }
    }
    if (!contactDrawn) {
      state.setClashContactLines(null);
      state.setClashOverlapBox(clash.bounds ? { min: clash.bounds.min, max: clash.bounds.max } : null);
    }
    applyFocusMode(globalIds, mode);
    state.setClashSelectedId(clash.id);
    const framing = clash.bounds ? clashFramingBounds(clash.bounds) : null;
    requestAnimationFrame(() => {
      const cb = useViewerStore.getState().cameraCallbacks;
      if (framing && cb.frameClashRegion) {
        cb.frameClashRegion(
          { x: framing.min[0], y: framing.min[1], z: framing.min[2] },
          { x: framing.max[0], y: framing.max[1], z: framing.max[2] },
        );
      } else {
        cb.frameSelection?.();
      }
    });
    const mySolidRequestSeq = useViewerStore.getState().clashSolidRequestSeq;
    state.setClashSolidComputing();
    if (elA && elB) {
      computeClashIntersectionSolid(elA.positions, elA.indices, elB.positions, elB.indices)
        .then((result) => {
          if (useViewerStore.getState().clashSolidRequestSeq !== mySolidRequestSeq) return;
          const s = useViewerStore.getState();
          if (result.isSolid) {
            s.setClashSolid({ positions: result.positions, indices: result.indices }, result.volumeM3);
            const ghostExceptEntities = new Set<number>();
            installClashGhost(ghostExceptEntities);
            s.setClashHighlightColors(null);
            s.setPendingColorUpdates(restoreOverridesForGhosting(s.lensAppliedColors, ghostExceptEntities));
            s.setClashContactLines(null);
            s.setClashOverlapBox(null);
          } else {
            s.setClashSolidUnavailable(result.reason, result.thicknessM, result.requiredM);
          }
        })
        .catch(() => {
          if (useViewerStore.getState().clashSolidRequestSeq !== mySolidRequestSeq) return;
          useViewerStore.getState().setClashSolidUnavailable('compute-error', 0, 0);
        });
    } else {
      state.setClashSolidUnavailable('empty-operand', 0, 0);
    }
  };
  const selectElement = (el: ClashElementRef, mode: ClashFocusMode = 'highlight'): void => {
    const state = useViewerStore.getState();
    const ref = refOf(el);
    if (!ref) return;
    state.clearEntitySelection();
    const one = new Map<number, [number, number, number, number]>([[el.ref, CLASH_COLOR_A]]);
    state.setClashHighlightColors(one);
    state.setPendingColorUpdates(one);
    state.setClashOverlapBox(null);
    state.setClashContactLines(null);
    state.clearClashSolid();
    applyFocusMode([el.ref], mode);
    requestAnimationFrame(() => state.cameraCallbacks.frameSelection?.());
  };
  const highlightAll = (): void => {
    const state = useViewerStore.getState();
    const current = state.clashResult;
    if (!current) return;
    const globalIds = new Set<number>();
    const refs: SelectionRef[] = [];
    for (const clash of current.clashes) {
      for (const el of [clash.a, clash.b]) {
        const ref = refOf(el);
        if (ref) {
          globalIds.add(el.ref);
          refs.push(ref);
        }
      }
    }
    if (globalIds.size === 0) return;
    state.setSelectedEntityIds([...globalIds]);
    state.addEntitiesToSelection(refs);
    state.setClashHighlightColors(null);
    state.setPendingColorUpdates(state.lensAppliedColors ?? new Map());
    state.setClashOverlapBox(null);
    state.setClashContactLines(null);
    state.clearClashSolid();
  };
  const clearHighlight = (): void => {
    const state = useViewerStore.getState();
    state.clearEntitySelection();
    state.clearIsolation();
    state.clearGhost();
    state.clearClashFocus();
    state.setPendingColorUpdates(state.lensAppliedColors ?? new Map());
  };
  return { focusClash, focusClashes, selectElement, highlightAll, clearHighlight };
}
