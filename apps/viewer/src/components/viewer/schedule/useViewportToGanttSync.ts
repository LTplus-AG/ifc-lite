/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * useViewportToGanttSync — when a user clicks a product in the 3D viewport,
 * find the first task that owns it and highlight that row in the Gantt.
 *
 * Also:
 *   • Expands every ancestor row so the target row is actually visible in
 *     the tree.
 *   • Returns an auto-scroll ref-target so the caller can smoothly scroll
 *     the task-tree to the hit row. (Implemented as a queued "scrollToId"
 *     in the slice? — no, we pass this back via a callback the Gantt
 *     component resolves into DOM scrolling.)
 *
 * Gated by `ganttSync3D`. When the sync is OFF, clicking products in the
 * viewport does nothing to the Gantt.
 *
 * Guarded against feedback loops: we only act when the viewport selection
 * changes independently of a Gantt-driven selection update. The
 * `useGanttSelection3DSync` hook writes isolation, not viewport selection,
 * so there's no direct loop — but `onDoubleClickRowFrame` in GanttPanel
 * DOES set viewport selection. To avoid flipping the Gantt row when we
 * programmatically set viewport selection on dbl-click, we debounce with a
 * `lastOriginRef` token set briefly after a Gantt-originated write.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import { findTaskForProductGlobalIdWithLocal } from './schedule-selection';

/**
 * Return type is `{ acknowledgeGanttOrigin }`: callers that programmatically
 * set viewport selection from the Gantt (e.g. double-click-to-frame) invoke
 * this just before the write so the reverse-sync ignores the echo.
 */
export interface ViewportToGanttSyncHandle {
  acknowledgeGanttOrigin: () => void;
}

export function useViewportToGanttSync(
  /** Called after selection changes so the caller can scroll the tree. */
  onAfterHighlight?: (taskGlobalId: string) => void,
): ViewportToGanttSyncHandle {
  const scheduleData = useViewerStore(s => s.scheduleData);
  const selectedEntityId = useViewerStore(s => s.selectedEntityId);
  const ganttSync3D = useViewerStore(s => s.ganttSync3D);

  /**
   * Timestamp (performance.now) of the most recent Gantt-driven viewport
   * write. Any viewport selection change observed within 200 ms is treated
   * as the echo of that write and skipped, preventing a feedback flash.
   */
  const ganttOriginAtRef = useRef<number>(0);
  /** Last task we wrote, so we don't thrash the expanded-set on re-renders. */
  const lastHitRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ganttSync3D || !scheduleData) return;
    if (selectedEntityId === null || selectedEntityId === undefined) {
      lastHitRef.current = null;
      return;
    }
    // Ignore the echo of a Gantt-originated viewport write.
    if (performance.now() - ganttOriginAtRef.current < 200) return;

    const store = useViewerStore.getState();
    const models = store.models;
    // Federation-aware fallback: resolve global → local for the active
    // source model so extracted (non-generated) schedules still sync.
    const activeModelId = store.activeModelId;
    const sourceModelId = activeModelId
      ?? (models.size === 1 ? (models.keys().next().value ?? '') : '');
    const sourceModel = sourceModelId ? models.get(sourceModelId) : undefined;
    const idOffset = sourceModel?.idOffset ?? 0;

    const hit = findTaskForProductGlobalIdWithLocal(
      scheduleData,
      selectedEntityId,
      (globalId) => globalId - idOffset,
    );
    if (!hit) {
      // Product isn't scheduled — clear the Gantt selection so the user
      // sees "nothing" rather than a stale row linked to a prior click.
      if (lastHitRef.current !== null) {
        store.setSelectedTaskGlobalIds([]);
        lastHitRef.current = null;
      }
      return;
    }
    if (lastHitRef.current === hit.taskGlobalId) return;

    // Expand every ancestor so the hit row is visible in the tree. Then
    // select the hit row. Use a fresh expanded set to avoid clobbering
    // concurrent toggles from the user.
    const currentExpanded = store.expandedTaskGlobalIds;
    const nextExpanded = new Set(currentExpanded);
    for (const g of hit.ancestorGlobalIds) nextExpanded.add(g);
    // Setting expandedTaskGlobalIds directly would require a new action;
    // we toggle ancestors that aren't already expanded via the existing
    // toggleTaskExpanded slice action so state transitions stay audited.
    for (const g of hit.ancestorGlobalIds) {
      if (!currentExpanded.has(g)) store.toggleTaskExpanded(g);
    }
    store.setSelectedTaskGlobalIds([hit.taskGlobalId]);
    lastHitRef.current = hit.taskGlobalId;
    onAfterHighlight?.(hit.taskGlobalId);
  }, [scheduleData, selectedEntityId, ganttSync3D, onAfterHighlight]);

  return {
    acknowledgeGanttOrigin: () => {
      ganttOriginAtRef.current = performance.now();
    },
  };
}
