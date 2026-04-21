/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GanttPanel — 4D / IfcTask Gantt chart rendered in the viewer's bottom panel.
 *
 * Gantt ↔ 3D interactions are deliberately minimal: selecting task rows
 * isolates their products in the 3D viewport (via `useGanttSelection3DSync`),
 * and nothing else. No double-click, no right-click menu, no keyboard
 * shortcuts, no reverse sync — one interaction, one effect. The master
 * `ganttSync3D` toggle in the toolbar disables it entirely.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
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

  // Isolate 3D by the current Gantt selection. Disabled automatically while
  // animation is playing so the 4D animator owns visibility end-to-end.
  useGanttSelection3DSync();

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
  const canGenerate = useMemo(
    () => canGenerateScheduleFrom(activeStore),
    [activeStore],
  );

  const handleSelect = (globalId: string, multi: boolean) => {
    const current = new Set(selectedTaskGlobalIds);
    if (multi) {
      if (current.has(globalId)) current.delete(globalId);
      else current.add(globalId);
    } else {
      current.clear();
      current.add(globalId);
    }
    setSelectedTaskGlobalIds(Array.from(current));
  };

  const showEmpty = !scheduleData || !scheduleRange || rows.length === 0;

  return (
    <div className="h-full w-full flex flex-col overflow-hidden bg-background">
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
