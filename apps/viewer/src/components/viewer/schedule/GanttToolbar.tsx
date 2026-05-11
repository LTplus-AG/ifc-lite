/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GanttToolbar — play/pause, timeline scrubber, speed control,
 * work-schedule selector, and animation toggle.
 */

import { useCallback, useMemo } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Repeat,
  Repeat2,
  Gauge,
  Calendar,
  CalendarPlus,
  Plus,
  X,
  Trash2,
  Undo2,
  Redo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useViewerStore, countGeneratedTasks } from '@/store';
import type { GanttTimeScale } from '@/store';
import { toast } from '@/components/ui/toast';
import { formatDateTime } from './schedule-utils';
import { AnimationSettingsPopover } from './AnimationSettingsPopover';

interface GanttToolbarProps {
  onClose?: () => void;
  onOpenGenerate?: () => void;
  canGenerate?: boolean;
}

const SPEED_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0.5, label: '0.5 d/s' },
  { value: 1, label: '1 d/s' },
  { value: 3, label: '3 d/s' },
  { value: 7, label: '1 w/s' },
  { value: 30, label: '1 mo/s' },
  { value: 90, label: '3 mo/s' },
];

const SCALE_OPTIONS: Array<{ value: GanttTimeScale; label: string }> = [
  { value: 'hour', label: 'Hour' },
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
];

// Radix Select rejects '' as a SelectItem value — use a sentinel for the
// "All tasks" option and translate at the API boundary.
const ALL_SCHEDULES_SENTINEL = '__all__';

export function GanttToolbar({ onClose, onOpenGenerate, canGenerate }: GanttToolbarProps) {
  const scheduleData = useViewerStore(s => s.scheduleData);
  const scheduleRange = useViewerStore(s => s.scheduleRange);
  const activeWorkScheduleId = useViewerStore(s => s.activeWorkScheduleId);
  const setActiveWorkScheduleId = useViewerStore(s => s.setActiveWorkScheduleId);
  const isPlaying = useViewerStore(s => s.playbackIsPlaying);
  const playbackTime = useViewerStore(s => s.playbackTime);
  const playbackSpeed = useViewerStore(s => s.playbackSpeed);
  const playbackLoop = useViewerStore(s => s.playbackLoop);
  const animationEnabled = useViewerStore(s => s.animationEnabled);
  const pendingGeneratedCount = useViewerStore(s => countGeneratedTasks(s.scheduleData));
  const clearGeneratedSchedule = useViewerStore(s => s.clearGeneratedSchedule);
  const undoDepth = useViewerStore(s => s.scheduleUndoStack.length);
  const redoDepth = useViewerStore(s => s.scheduleRedoStack.length);
  const undoScheduleEdit = useViewerStore(s => s.undoScheduleEdit);
  const redoScheduleEdit = useViewerStore(s => s.redoScheduleEdit);
  const addTaskAction = useViewerStore(s => s.addTask);
  const selectedTaskGlobalIds = useViewerStore(s => s.selectedTaskGlobalIds);
  const scale = useViewerStore(s => s.ganttTimeScale);
  const togglePlay = useViewerStore(s => s.togglePlaySchedule);
  const pause = useViewerStore(s => s.pauseSchedule);
  const seek = useViewerStore(s => s.seekSchedule);
  const setSpeed = useViewerStore(s => s.setPlaybackSpeed);
  const setLoop = useViewerStore(s => s.setPlaybackLoop);
  const setAnimationEnabled = useViewerStore(s => s.setAnimationEnabled);
  const setScale = useViewerStore(s => s.setGanttTimeScale);

  const hasData = !!scheduleData && scheduleData.tasks.length > 0;
  const hasDates = !!scheduleRange && !scheduleRange.synthetic;

  const scheduleOptions = useMemo(() => {
    if (!scheduleData) return [];
    return [
      { value: ALL_SCHEDULES_SENTINEL, label: 'All tasks' },
      ...scheduleData.workSchedules.map(s => ({
        value: s.globalId,
        label: s.name || s.globalId,
      })),
    ];
  }, [scheduleData]);

  const selectedScheduleValue = activeWorkScheduleId || ALL_SCHEDULES_SENTINEL;
  const handleScheduleChange = useCallback((value: string) => {
    setActiveWorkScheduleId(value === ALL_SCHEDULES_SENTINEL ? '' : value);
  }, [setActiveWorkScheduleId]);

  const scrubPercent = useMemo(() => {
    if (!scheduleRange) return 0;
    const span = scheduleRange.end - scheduleRange.start;
    if (span <= 0) return 0;
    return Math.min(100, Math.max(0, ((playbackTime - scheduleRange.start) / span) * 100));
  }, [scheduleRange, playbackTime]);

  const onScrubInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!scheduleRange) return;
    const pct = parseFloat(e.target.value) / 100;
    seek(scheduleRange.start + pct * (scheduleRange.end - scheduleRange.start));
  }, [scheduleRange, seek]);

  const onScrubPointerDown = useCallback(() => {
    if (isPlaying) pause();
  }, [isPlaying, pause]);

  const goStart = useCallback(() => {
    if (scheduleRange) seek(scheduleRange.start);
  }, [scheduleRange, seek]);

  const goEnd = useCallback(() => {
    if (scheduleRange) seek(scheduleRange.end);
  }, [scheduleRange, seek]);

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b bg-card/40 text-sm">
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={goStart}
              disabled={!hasData}
              aria-label="Jump to start"
            >
              <SkipBack className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Jump to start</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant={isPlaying ? 'default' : 'ghost'}
              onClick={togglePlay}
              disabled={!hasData}
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{isPlaying ? 'Pause' : 'Play'} construction sequence</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={goEnd}
              disabled={!hasData}
              aria-label="Jump to finish"
            >
              <SkipForward className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Jump to finish</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant={playbackLoop ? 'default' : 'ghost'}
              onClick={() => setLoop(!playbackLoop)}
              aria-label={playbackLoop ? 'Disable loop' : 'Enable loop'}
            >
              {playbackLoop ? <Repeat className="h-4 w-4" /> : <Repeat2 className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{playbackLoop ? 'Looping' : 'One-shot'}</TooltipContent>
        </Tooltip>
      </div>

      {/* Scrub bar */}
      <div className="flex-1 flex items-center gap-2 min-w-[240px]">
        <input
          type="range"
          min={0}
          max={100}
          step={0.01}
          value={scrubPercent}
          onChange={onScrubInput}
          onPointerDown={onScrubPointerDown}
          disabled={!hasData}
          className="flex-1 accent-primary cursor-pointer h-1 appearance-none bg-muted rounded-full"
          aria-label="Playback position"
        />
        <span className="text-xs text-muted-foreground font-mono whitespace-nowrap">
          {hasData ? formatDateTime(playbackTime) : '—'}
        </span>
      </div>

      {/* Work schedule dropdown */}
      <div className="flex items-center gap-1">
        <Calendar className="h-4 w-4 text-muted-foreground" />
        <Select value={selectedScheduleValue} onValueChange={handleScheduleChange}>
          <SelectTrigger className="h-8 w-[180px] text-xs">
            <SelectValue placeholder="All tasks" />
          </SelectTrigger>
          <SelectContent>
            {scheduleOptions.map(opt => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Speed */}
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Gauge className="h-4 w-4 text-muted-foreground" />
          </TooltipTrigger>
          <TooltipContent>Simulation speed</TooltipContent>
        </Tooltip>
        <Select
          value={String(playbackSpeed)}
          onValueChange={(v) => setSpeed(parseFloat(v))}
        >
          <SelectTrigger className="h-8 w-[110px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SPEED_OPTIONS.map(opt => (
              <SelectItem key={opt.value} value={String(opt.value)}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Scale */}
      <Select value={scale} onValueChange={(v) => setScale(v as GanttTimeScale)}>
        <SelectTrigger className="h-8 w-[90px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SCALE_OPTIONS.map(opt => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Generate from spatial hierarchy */}
      {onOpenGenerate && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={onOpenGenerate}
              disabled={!canGenerate}
              aria-label="Generate construction schedule"
            >
              <CalendarPlus className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {canGenerate ? 'Generate schedule…' : 'No spatial hierarchy or geometry to generate from'}
          </TooltipContent>
        </Tooltip>
      )}

      {/* + Task — insert a new task after the currently-selected row
          (or at the end when none is selected). Auto-selects the new
          task so the Inspector's Task card lights up for rename. */}
      {hasData && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => {
                const afterGlobalId = selectedTaskGlobalIds.size === 1
                  ? selectedTaskGlobalIds.values().next().value
                  : undefined;
                addTaskAction({ afterGlobalId });
              }}
              aria-label="Add task"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add task (after selection or at end)</TooltipContent>
        </Tooltip>
      )}

      {/* Undo / Redo for schedule edits. Gated on stack depth so the
          buttons only appear when there's actually something to undo —
          avoids a persistent greyed-out pair on clean schedules. */}
      {(undoDepth > 0 || redoDepth > 0) && (
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={undoScheduleEdit}
                disabled={undoDepth === 0}
                aria-label="Undo schedule edit"
              >
                <Undo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Undo (Ctrl+Z)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={redoScheduleEdit}
                disabled={redoDepth === 0}
                aria-label="Redo schedule edit"
              >
                <Redo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Redo (Ctrl+Shift+Z)</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Discard pending generated schedule — only visible when at least
          one locally-generated task exists. Keeps extracted tasks intact
          so partial-authoring workflows can still revert just the
          pending tail. */}
      {pendingGeneratedCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => {
                const removed = clearGeneratedSchedule();
                if (removed > 0) {
                  toast.success(`Discarded ${removed} pending task${removed === 1 ? '' : 's'}.`);
                }
              }}
              aria-label={`Discard ${pendingGeneratedCount} pending generated task${pendingGeneratedCount === 1 ? '' : 's'}`}
              className="text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Discard {pendingGeneratedCount} pending schedule task{pendingGeneratedCount === 1 ? '' : 's'}
          </TooltipContent>
        </Tooltip>
      )}

      {/* Animation settings popover (replaces the bare toggle — gives the
          user access to lifecycle colour / palette / preparation window). */}
      <AnimationSettingsPopover
        animationEnabled={animationEnabled}
        onToggleAnimation={() => setAnimationEnabled(!animationEnabled)}
      />

      {onClose && (
        <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close Gantt panel">
          <X className="h-4 w-4" />
        </Button>
      )}

      {hasData && !hasDates && (
        <span className="text-xs text-amber-500 whitespace-nowrap" title="No real dates — using synthetic range">
          No dates
        </span>
      )}
    </div>
  );
}
