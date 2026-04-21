/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useGanttInteractions — centralises the imperative actions triggered by
 * Gantt ↔ 3D interactions (double-click, keyboard shortcuts, context menu
 * commands). Everything here operates in renderer GLOBAL IDs.
 *
 * Returned actions:
 *   • `isolateSelection()` — isolate current Gantt selection in 3D.
 *   • `frameSelection()`  — set viewport selection to the Gantt-selected
 *     products AND call `cameraCallbacks.frameSelection()`. This changes
 *     viewport selection by design: "show me what this task touches" is
 *     most naturally expressed as "select it and zoom".
 *   • `clearSelection()` — clear the Gantt's own selection (which through
 *     `useGanttSelection3DSync` restores prior isolation).
 *   • `selectInViewport()` — set viewport selection without framing (a
 *     cheaper variant surfaced in the context menu).
 *
 * All actions are inert when there's nothing to act on — no empty
 * selections ever ping the renderer. Keyboard handlers are returned
 * separately so the caller can attach them to the right focus root.
 */

import { useCallback } from 'react';
import { useViewerStore, toGlobalIdFromModels } from '@/store';
import { collectProductLocalIdsForTasks } from './schedule-selection';
import type { ViewportToGanttSyncHandle } from './useViewportToGanttSync';

export interface GanttInteractionActions {
  /** Take the Gantt selection's products global IDs (descendant-aware). */
  computeGlobalProductIds: (taskGlobalIds?: Iterable<string>) => number[];
  /** Isolate the Gantt-selected tasks' products in 3D. */
  isolateSelection: (taskGlobalIds?: Iterable<string>) => void;
  /** Set viewport selection + frame camera on it. */
  frameSelection: (taskGlobalIds?: Iterable<string>) => void;
  /** Set viewport selection without framing. */
  selectInViewport: (taskGlobalIds?: Iterable<string>) => void;
  /** Clear the Gantt's task selection (isolation is restored by the sync hook). */
  clearGanttSelection: () => void;
  /** Keyboard handler — wire to the Gantt panel's focus root. */
  onKeyDown: (event: React.KeyboardEvent) => void;
}

export function useGanttInteractions(
  viewportToGanttHandle?: ViewportToGanttSyncHandle,
): GanttInteractionActions {
  const computeGlobalProductIds = useCallback((taskGlobalIdsOverride?: Iterable<string>): number[] => {
    const store = useViewerStore.getState();
    const taskIds = taskGlobalIdsOverride ?? store.selectedTaskGlobalIds;
    const localIds = collectProductLocalIdsForTasks(store.scheduleData, taskIds);
    if (localIds.size === 0) return [];

    const models = store.models;
    const activeModelId = store.activeModelId;
    const sourceModelId = activeModelId
      ?? (models.size === 1 ? (models.keys().next().value ?? '') : '');

    const globals: number[] = [];
    for (const local of localIds) {
      globals.push(toGlobalIdFromModels(models, sourceModelId, local));
    }
    return globals;
  }, []);

  const isolateSelection = useCallback((taskGlobalIds?: Iterable<string>) => {
    const ids = computeGlobalProductIds(taskGlobalIds);
    if (ids.length === 0) return;
    // Direct call — bypasses the sync hook because the caller typically
    // triggers this via a menu/key that already has task selection. The
    // sync hook will still be in charge of restoration when the selection
    // clears.
    useViewerStore.getState().setIsolatedEntities(new Set(ids));
  }, [computeGlobalProductIds]);

  const selectInViewport = useCallback((taskGlobalIds?: Iterable<string>) => {
    const ids = computeGlobalProductIds(taskGlobalIds);
    if (ids.length === 0) return;
    // Tell the reverse-sync hook that the next viewport change is
    // Gantt-originated so it doesn't bounce back and re-select the same
    // task we already have selected.
    viewportToGanttHandle?.acknowledgeGanttOrigin();
    useViewerStore.getState().setSelectedEntityIds(ids);
  }, [computeGlobalProductIds, viewportToGanttHandle]);

  const frameSelection = useCallback((taskGlobalIds?: Iterable<string>) => {
    const ids = computeGlobalProductIds(taskGlobalIds);
    if (ids.length === 0) return;
    viewportToGanttHandle?.acknowledgeGanttOrigin();
    const store = useViewerStore.getState();
    store.setSelectedEntityIds(ids);
    // `frameSelection` frames whatever's currently selected. We just set
    // it; the callback may run synchronously against stale state on the
    // first tick, so we defer by a microtask to let the renderer pick up
    // the new selection before framing.
    queueMicrotask(() => {
      useViewerStore.getState().cameraCallbacks.frameSelection?.();
    });
  }, [computeGlobalProductIds, viewportToGanttHandle]);

  const clearGanttSelection = useCallback(() => {
    useViewerStore.getState().setSelectedTaskGlobalIds([]);
  }, []);

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    // Only act on plain keypresses (no modifier) so we don't eat
    // browser shortcuts (Ctrl+F = find, etc).
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // Ignore when the user is typing into an input element inside the
    // Gantt panel — otherwise pressing `f` in a future text field would
    // fight the camera-frame shortcut.
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }

    switch (event.key) {
      case 'i':
      case 'I':
        event.preventDefault();
        isolateSelection();
        break;
      case 'f':
      case 'F':
        event.preventDefault();
        frameSelection();
        break;
      case 'Escape':
        // Escape clears only Gantt selection — doesn't also nuke viewport
        // selection so the user's 3D click state survives panel dismissal.
        event.preventDefault();
        clearGanttSelection();
        break;
    }
  }, [isolateSelection, frameSelection, clearGanttSelection]);

  return {
    computeGlobalProductIds,
    isolateSelection,
    frameSelection,
    selectInViewport,
    clearGanttSelection,
    onKeyDown,
  };
}
