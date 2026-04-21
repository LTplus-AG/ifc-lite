/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GanttPanel — 4D / IfcTask Gantt chart rendered in the viewer's bottom panel.
 *
 * Responsibilities:
 *   • Extract schedule data on mount (IfcTask / IfcWorkSchedule / IfcRelSequence)
 *   • Render split layout: task-tree (left) | Gantt timeline (right)
 *   • Drive construction-sequence animation by writing into visibilitySlice
 *     whenever playbackTime / animationEnabled change.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { extractScheduleOnDemand } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { GanttToolbar } from './GanttToolbar';
import { GanttTaskTree } from './GanttTaskTree';
import { GanttTimeline } from './GanttTimeline';
import { GanttEmptyState } from './GanttEmptyState';
import { GenerateScheduleDialog } from './GenerateScheduleDialog';
import { flattenTaskTree } from './schedule-utils';
import { canGenerateScheduleFrom, resolveActiveDataStore } from './generate-schedule';
import { useConstructionSequence } from './useConstructionSequence';
import { useGanttSelection3DSync } from './useGanttSelection3DSync';
import { useViewportToGanttSync } from './useViewportToGanttSync';
import { useGanttInteractions } from './useGanttInteractions';
import { GanttRowContextMenu, type GanttContextMenuState } from './GanttRowContextMenu';

interface GanttPanelProps {
  onClose?: () => void;
}

const LEFT_PANE_WIDTH = 320;

export function GanttPanel({ onClose }: GanttPanelProps) {
  const { ifcDataStore, models, loading, activeModelId } = useIfc();

  // Resolve the active model once; shared by extraction + canGenerate.
  const activeStore = useMemo(
    () => resolveActiveDataStore(ifcDataStore, activeModelId, models),
    [ifcDataStore, activeModelId, models],
  );

  const {
    scheduleData,
    scheduleRange,
    activeWorkScheduleId,
    expandedTaskGlobalIds,
    hoveredTaskGlobalId,
    selectedTaskGlobalIds,
    ganttTimeScale,
    playbackTime,
    setScheduleData,
    toggleTaskExpanded,
    setHoveredTaskGlobalId,
    setSelectedTaskGlobalIds,
    seekSchedule,
  } = useViewerStore(useShallow(s => ({
    scheduleData: s.scheduleData,
    scheduleRange: s.scheduleRange,
    activeWorkScheduleId: s.activeWorkScheduleId,
    expandedTaskGlobalIds: s.expandedTaskGlobalIds,
    hoveredTaskGlobalId: s.hoveredTaskGlobalId,
    selectedTaskGlobalIds: s.selectedTaskGlobalIds,
    ganttTimeScale: s.ganttTimeScale,
    playbackTime: s.playbackTime,
    setScheduleData: s.setScheduleData,
    toggleTaskExpanded: s.toggleTaskExpanded,
    setHoveredTaskGlobalId: s.setHoveredTaskGlobalId,
    setSelectedTaskGlobalIds: s.setSelectedTaskGlobalIds,
    seekSchedule: s.seekSchedule,
  })));

  // Extract schedule data whenever the resolved data store changes.
  useEffect(() => {
    if (!activeStore) {
      if (scheduleData) setScheduleData(null);
      setExtractionError(null);
      return;
    }
    try {
      const extraction = extractScheduleOnDemand(activeStore);
      setScheduleData(extraction.hasSchedule ? extraction : null);
      setExtractionError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[GanttPanel] Failed to extract schedule', err);
      setScheduleData(null);
      setExtractionError(message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStore]);

  // Drive the 3D viewport's hidden-entity set from the playback clock.
  useConstructionSequence();

  // Isolate 3D by the current Gantt selection (master toggle: ganttSync3D).
  useGanttSelection3DSync();

  // Flatten task tree honoring expand/collapse state.
  const rows = useMemo(
    () => flattenTaskTree(scheduleData, expandedTaskGlobalIds, activeWorkScheduleId || undefined),
    [scheduleData, expandedTaskGlobalIds, activeWorkScheduleId],
  );

  // Shared scroll position between task list and timeline (so rows line up).
  const [scrollTop, setScrollTop] = useState(0);
  const leftRef = useRef<HTMLDivElement>(null);

  /**
   * Scroll the Gantt to the row matching a given taskGlobalId. Shared by
   * the reverse-sync (viewport click → highlight) so the user always sees
   * what just got selected. Uses the row order from the flattened tree to
   * find the pixel offset — has to run *after* ancestor-expansion so the
   * target row's index reflects the now-visible layout.
   */
  const scrollToTask = useCallback((taskGlobalId: string) => {
    // Defer so React has committed any expansion the reverse-sync queued.
    requestAnimationFrame(() => {
      const current = useViewerStore.getState();
      const expanded = current.expandedTaskGlobalIds;
      const flat = flattenTaskTree(
        current.scheduleData,
        expanded,
        current.activeWorkScheduleId || undefined,
      );
      const idx = flat.findIndex(r => r.task.globalId === taskGlobalId);
      if (idx < 0) return;
      // GANTT_ROW_HEIGHT is 28 (shared with GanttTaskTree). Center in pane.
      const ROW = 28;
      const HEADER = 28;
      const container = leftRef.current;
      if (!container) return;
      const viewportH = container.clientHeight - HEADER;
      const target = Math.max(0, idx * ROW - viewportH / 2 + ROW / 2);
      setScrollTop(target);
    });
  }, []);

  // Reverse sync: viewport click → highlight owning task row.
  const viewportToGanttHandle = useViewportToGanttSync(scrollToTask);

  // Imperative actions (isolate / frame / select / clear / keyboard).
  const interactions = useGanttInteractions(viewportToGanttHandle);

  /** Right-click context-menu state (anchor + target task). */
  const [ctxMenu, setCtxMenu] = useState<GanttContextMenuState | null>(null);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  /** Last schedule-extraction error message (surfaced in the empty state). */
  const [extractionError, setExtractionError] = useState<string | null>(null);

  // Generate-from-storeys dialog state lives in the slice so the command
  // palette / hotkeys can open it without going through this component.
  const generateOpen = useViewerStore(s => s.generateScheduleDialogOpen);
  const setGenerateOpen = useViewerStore(s => s.setGenerateScheduleDialogOpen);
  const canGenerate = useMemo(
    () => canGenerateScheduleFrom(activeStore),
    [activeStore],
  );

  const handleSelect = useCallback((globalId: string, multi: boolean) => {
    const current = new Set(selectedTaskGlobalIds);
    if (multi) {
      if (current.has(globalId)) current.delete(globalId);
      else current.add(globalId);
    } else {
      current.clear();
      current.add(globalId);
    }
    setSelectedTaskGlobalIds(Array.from(current));
  }, [selectedTaskGlobalIds, setSelectedTaskGlobalIds]);

  /**
   * Double-click a row → "show me this" = select it, select its products
   * in 3D, frame the camera on them. Selecting first so users with
   * multi-row selection get the full group framed together.
   */
  const handleRowDoubleClick = useCallback((globalId: string, multi: boolean) => {
    const shouldKeepMulti = multi && selectedTaskGlobalIds.has(globalId);
    const effective: string[] = shouldKeepMulti
      ? Array.from(selectedTaskGlobalIds)
      : [globalId];
    // Update Gantt selection first so the sync hook isolates to the right set.
    if (!shouldKeepMulti) setSelectedTaskGlobalIds(effective);
    // Then frame — reuses current Gantt selection via the interactions hook.
    interactions.frameSelection(effective);
  }, [interactions, selectedTaskGlobalIds, setSelectedTaskGlobalIds]);

  /** Right-click → open the context menu at the cursor. */
  const handleRowContextMenu = useCallback((
    event: React.MouseEvent,
    globalId: string,
    label: string,
  ) => {
    event.preventDefault();
    // Ensure the clicked row is in the effective target set for the menu.
    // If it's already selected, leave the selection alone; otherwise
    // make this row the single-item selection so commands act on it.
    if (!selectedTaskGlobalIds.has(globalId)) {
      setSelectedTaskGlobalIds([globalId]);
    }
    setCtxMenu({
      taskGlobalId: globalId,
      label,
      anchorX: event.clientX,
      anchorY: event.clientY,
    });
  }, [selectedTaskGlobalIds, setSelectedTaskGlobalIds]);

  const showEmpty = !scheduleData || !scheduleRange || rows.length === 0;

  return (
    <div
      className="h-full w-full flex flex-col overflow-hidden bg-background outline-none"
      // `tabIndex={0}` so keyboard shortcuts fire while the Gantt has focus.
      tabIndex={0}
      onKeyDown={interactions.onKeyDown}
    >
      <GanttToolbar
        onClose={onClose}
        onOpenGenerate={() => setGenerateOpen(true)}
        canGenerate={canGenerate}
      />

      <GenerateScheduleDialog open={generateOpen} onOpenChange={setGenerateOpen} />

      {showEmpty ? (
        <GanttEmptyState
          loading={loading}
          hasModel={!!ifcDataStore || models.size > 0}
          canGenerate={canGenerate}
          extractionError={extractionError}
          onGenerate={() => setGenerateOpen(true)}
          onClose={onClose}
        />
      ) : (
        <div className="flex-1 min-h-0 flex">
          <div
            ref={leftRef}
            style={{ width: LEFT_PANE_WIDTH, flex: `0 0 ${LEFT_PANE_WIDTH}px` }}
            className="relative"
          >
            <GanttTaskTree
              rows={rows}
              selectedGlobalIds={selectedTaskGlobalIds}
              hoveredGlobalId={hoveredTaskGlobalId}
              onToggleExpand={toggleTaskExpanded}
              onSelect={handleSelect}
              onDoubleClickRow={handleRowDoubleClick}
              onContextMenuRow={handleRowContextMenu}
              onHover={setHoveredTaskGlobalId}
              scrollTop={scrollTop}
              onScroll={setScrollTop}
            />
          </div>
          <div className="flex-1 min-w-0">
            <GanttTimeline
              rows={rows}
              data={scheduleData}
              range={scheduleRange}
              scale={ganttTimeScale}
              playbackTime={playbackTime}
              selectedGlobalIds={selectedTaskGlobalIds}
              hoveredGlobalId={hoveredTaskGlobalId}
              onSelect={handleSelect}
              onDoubleClickRow={handleRowDoubleClick}
              onContextMenuRow={handleRowContextMenu}
              onHover={setHoveredTaskGlobalId}
              onScrubSeek={seekSchedule}
              scrollTop={scrollTop}
              onScroll={setScrollTop}
            />
          </div>
        </div>
      )}

      <GanttRowContextMenu
        state={ctxMenu}
        onClose={closeCtxMenu}
        interactions={interactions}
      />
    </div>
  );
}
