/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GanttPanel — 4D / IfcTask Gantt chart rendered in the viewer's bottom panel.
 *
 * Gantt ↔ 3D: selecting task rows highlights their products in the 3D
 * viewport via the renderer's selection-highlight channel (no isolation,
 * no hiding — highlight only). Clearing the selection removes the
 * highlight. The 4D animator runs completely uninterrupted either way.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { extractScheduleOnDemand } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { resolveScheduleSourceModelId } from '@/store/slices/schedule-edit-helpers';
import { useIfc } from '@/hooks/useIfc';
import { GanttToolbar } from './GanttToolbar';
import { GanttTaskTree } from './GanttTaskTree';
import { GanttTimeline } from './GanttTimeline';
import { GanttEmptyState } from './GanttEmptyState';
import { GenerateScheduleDialog } from './GenerateScheduleDialog';
import { flattenTaskTree } from './schedule-utils';
import { canGenerateScheduleFrom, resolveActiveDataStore } from './generate-schedule';
import { useConstructionSequence } from './useConstructionSequence';
import { useGanttSelection3DHighlight } from './useGanttSelection3DHighlight';
import { useOverlayCompositor } from './useOverlayCompositor';

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

  /** Last schedule-extraction error message (surfaced in the empty state). */
  const [extractionError, setExtractionError] = useState<string | null>(null);

  // Extract schedule data whenever the resolved data store changes.
  useEffect(() => {
    if (!activeStore) {
      if (scheduleData) setScheduleData(null);
      setExtractionError(null);
      return;
    }
    try {
      const extraction = extractScheduleOnDemand(activeStore);

      // CRITICAL guard: do NOT overwrite an in-memory user-edited /
      // generated schedule with null just because the underlying
      // IfcDataStore reference shifted (this effect re-runs when
      // geometry finishes streaming, spatial hierarchy rebuilds, or
      // any other store mutation changes the activeStore identity).
      // Earlier revisions did `setScheduleData(hasSchedule ? extraction
      // : null)` unconditionally, which silently wiped the generated
      // schedule moments before the user clicked Export — leading to
      // an exported IFC with no task entities and an empty Gantt on
      // re-import. Only replace when the extraction actually has data,
      // or when we've previously had no schedule in memory.
      const s = useViewerStore.getState();
      const hasPendingSchedule = !!s.scheduleData && s.scheduleData.tasks.length > 0
        && (s.scheduleIsEdited || s.scheduleData.tasks.some(t => !t.expressId || t.expressId <= 0));
      if (extraction.hasSchedule) {
        // New extraction wins — this is the "fresh file with a real
        // schedule" case. Any generated tail in memory is replaced;
        // that's intentional because we can't reconcile it with a
        // different source.
        setScheduleData(extraction);
      } else if (!hasPendingSchedule) {
        // No extraction + no pending edits → fine to clear.
        setScheduleData(null);
      } // else: keep whatever's in memory (generated / edited).
      setExtractionError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[GanttPanel] Failed to extract schedule', err);
      setScheduleData(null);
      setExtractionError(message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStore]);

  // Single compositor — reads the overlay-layer registry and writes the
  // composite into the renderer's legacy hiddenEntities / pendingColorUpdates
  // channels. Must be mounted BEFORE any layer owner in the render tree so
  // its first reconcile can observe their initial contributions.
  useOverlayCompositor();

  // Drive the 3D viewport's hidden-entity set from the playback clock.
  // Registers the 'animation' overlay layer; the compositor above does
  // the actual write.
  useConstructionSequence();

  // Highlight the current Gantt selection's products in 3D. Selection-only
  // — no visibility changes — so it never interferes with the animator.
  useGanttSelection3DHighlight();

  // Flatten task tree honoring expand/collapse state.
  const rows = useMemo(
    () => flattenTaskTree(scheduleData, expandedTaskGlobalIds, activeWorkScheduleId || undefined),
    [scheduleData, expandedTaskGlobalIds, activeWorkScheduleId],
  );

  // Shared scroll position between task list and timeline (so rows line up).
  const [scrollTop, setScrollTop] = useState(0);
  const leftRef = useRef<HTMLDivElement>(null);

  // Generate-from-storeys dialog state lives in the slice so the command
  // palette / hotkeys can open it without going through this component.
  const generateOpen = useViewerStore(s => s.generateScheduleDialogOpen);
  const setGenerateOpen = useViewerStore(s => s.setGenerateScheduleDialogOpen);
  const canGenerate = useMemo(() => {
    // Geometry-only models (no spatial hierarchy) can still generate via
    // the Height strategy, so surface the button whenever EITHER a
    // spatial tree OR meshes exist on the active source model.
    const sourceModelId = resolveScheduleSourceModelId(models, activeModelId);
    const meshes = sourceModelId ? models.get(sourceModelId)?.geometryResult?.meshes : undefined;
    const ctx = meshes && meshes.length > 0
      ? { meshes, idOffset: models.get(sourceModelId!)?.idOffset ?? 0 }
      : undefined;
    return canGenerateScheduleFrom(activeStore, ctx);
  }, [activeStore, activeModelId, models]);

  const handleSelect = (globalId: string, multi: boolean) => {
    const current = new Set(selectedTaskGlobalIds);
    if (multi) {
      // Ctrl/Shift-click — toggle membership of the clicked row.
      if (current.has(globalId)) current.delete(globalId);
      else current.add(globalId);
    } else {
      // Plain click — toggle if it's the ONLY selected row (click again to
      // deselect), otherwise replace the selection. This is what users
      // expect from file-manager-style rows: one click selects, same click
      // again clears.
      const isSoleSelection = current.size === 1 && current.has(globalId);
      if (isSoleSelection) {
        current.clear();
      } else {
        current.clear();
        current.add(globalId);
      }
    }
    setSelectedTaskGlobalIds(Array.from(current));
  };

  /**
   * Empty-space click (task-tree background, timeline background) clears
   * the current Gantt selection. Matches the deselect ergonomics of every
   * other list widget and gives the user a predictable "out" that doesn't
   * require hunting the same row again.
   */
  const handleBackgroundClick = () => {
    if (selectedTaskGlobalIds.size > 0) setSelectedTaskGlobalIds([]);
  };

  const showEmpty = !scheduleData || !scheduleRange || rows.length === 0;

  // Keyboard shortcuts for schedule undo/redo — active only while the
  // Gantt panel (or a descendant) has focus, so the shortcut doesn't
  // steal Ctrl+Z from the script editor / text inputs elsewhere.
  const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    // Ignore when the user is typing into an input/textarea — the
    // browser's own undo history is usually what they want there.
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

    if (e.key === 'z' || e.key === 'Z') {
      e.preventDefault();
      if (e.shiftKey) useViewerStore.getState().redoScheduleEdit();
      else useViewerStore.getState().undoScheduleEdit();
    } else if (e.key === 'y' || e.key === 'Y') {
      e.preventDefault();
      useViewerStore.getState().redoScheduleEdit();
    }
  };

  return (
    <div
      className="h-full w-full flex flex-col overflow-hidden bg-background outline-none"
      tabIndex={-1}
      onKeyDown={onPanelKeyDown}
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
              onBackgroundClick={handleBackgroundClick}
              onReorder={(sourceGid, targetIdx) => {
                // The target index is the flattened-rows position of the
                // drop target. Map to the underlying tasks-array position
                // via the row's globalId. With a single-level tree this
                // is 1:1; nested children align because `rows` is a flat
                // pre-order traversal.
                const targetGid = rows[targetIdx]?.task.globalId;
                if (!targetGid) return;
                const store = useViewerStore.getState();
                const allTasks = store.scheduleData?.tasks ?? [];
                const newIdx = allTasks.findIndex(t => t.globalId === targetGid);
                if (newIdx >= 0) store.moveTask(sourceGid, newIdx);
              }}
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
              onHover={setHoveredTaskGlobalId}
              onScrubSeek={seekSchedule}
              scrollTop={scrollTop}
              onScroll={setScrollTop}
            />
          </div>
        </div>
      )}
    </div>
  );
}
