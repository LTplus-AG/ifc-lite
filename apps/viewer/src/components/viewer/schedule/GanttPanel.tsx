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
import { flattenTaskTree } from './schedule-utils';
import { useConstructionSequence } from './useConstructionSequence';

interface GanttPanelProps {
  onClose?: () => void;
}

const LEFT_PANE_WIDTH = 320;

export function GanttPanel({ onClose }: GanttPanelProps) {
  const { ifcDataStore, models, loading } = useIfc();

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

  // Extract schedule data whenever the primary data store changes. We prefer
  // the single-model legacy store; multi-model federation extraction is a
  // follow-up (pick the first model until then).
  useEffect(() => {
    const store = ifcDataStore ?? models.values().next().value?.ifcDataStore;
    if (!store) {
      if (scheduleData) setScheduleData(null);
      return;
    }
    try {
      const extraction = extractScheduleOnDemand(store);
      setScheduleData(extraction.hasSchedule ? extraction : null);
    } catch (err) {
      console.warn('[GanttPanel] Failed to extract schedule', err);
      setScheduleData(null);
    }
    // We intentionally depend only on ifcDataStore identity — models map
    // churns every selection, and a fresh extraction is cheap only when the
    // store object actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ifcDataStore]);

  // Drive the 3D viewport's hidden-entity set from the playback clock.
  useConstructionSequence();

  // Flatten task tree honoring expand/collapse state.
  const rows = useMemo(
    () => flattenTaskTree(scheduleData, expandedTaskGlobalIds, activeWorkScheduleId || undefined),
    [scheduleData, expandedTaskGlobalIds, activeWorkScheduleId],
  );

  // Shared scroll position between task list and timeline (so rows line up).
  const [scrollTop, setScrollTop] = useState(0);
  const leftRef = useRef<HTMLDivElement>(null);

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

  const showEmpty = !scheduleData || !scheduleRange || rows.length === 0;

  return (
    <div className="h-full w-full flex flex-col overflow-hidden bg-background">
      <GanttToolbar onClose={onClose} />

      {showEmpty ? (
        <GanttEmptyState
          loading={loading}
          hasModel={!!ifcDataStore || models.size > 0}
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
