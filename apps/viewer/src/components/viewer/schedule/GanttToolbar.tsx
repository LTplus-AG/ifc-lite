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
  Trash2,
  Undo2,
  Redo2,
  Upload,
} from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useViewerStore, countGeneratedTasks, type GanttTimeScale } from '@/store';
import { toast } from '@/components/ui/toast';
import { useTranslation, type TranslationKey } from '@/i18n';
import { AnimationSettingsPopover } from './AnimationSettingsPopover';
import { formatLocaleDate, formatLocaleNumber } from '@/i18n/intlFormat';

interface GanttToolbarProps {
  onOpenGenerate?: () => void;
  /** Opens the file picker to import an MS Project (MSPDI) / Gantt CSV file. */
  onOpenImport?: () => void;
  canGenerate?: boolean;
}

const SPEED_OPTIONS: Array<{ value: number; quantity: number; labelKey: TranslationKey }> = [
  { value: 0.5, quantity: 0.5, labelKey: 'schedule.toolbar.speedDaysPerSecond' },
  { value: 1, quantity: 1, labelKey: 'schedule.toolbar.speedDaysPerSecond' },
  { value: 3, quantity: 3, labelKey: 'schedule.toolbar.speedDaysPerSecond' },
  { value: 7, quantity: 1, labelKey: 'schedule.toolbar.speedWeeksPerSecond' },
  { value: 30, quantity: 1, labelKey: 'schedule.toolbar.speedMonthsPerSecond' },
  { value: 90, quantity: 3, labelKey: 'schedule.toolbar.speedMonthsPerSecond' },
];

const SCALE_OPTIONS: Array<{ value: GanttTimeScale; labelKey: TranslationKey }> = [
  { value: 'hour', labelKey: 'schedule.toolbar.scaleHour' },
  { value: 'day', labelKey: 'schedule.toolbar.scaleDay' },
  { value: 'week', labelKey: 'schedule.toolbar.scaleWeek' },
  { value: 'month', labelKey: 'schedule.toolbar.scaleMonth' },
  { value: 'year', labelKey: 'schedule.toolbar.scaleYear' },
];

// Radix Select rejects '' as a SelectItem value — use a sentinel for the
// "All tasks" option and translate at the API boundary.
const ALL_SCHEDULES_SENTINEL = '__all__';
const localizedCount = (locale: string, count: number) => ({ count, formattedCount: formatLocaleNumber(locale, count) });

export function GanttToolbar({ onOpenGenerate, onOpenImport, canGenerate }: GanttToolbarProps) {
  const { t, locale } = useTranslation();
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
  const allTasksLabel = t('schedule.toolbar.allTasks');
  const scheduleOptions = useMemo(() => {
    if (!scheduleData) return [];
    return [
      { value: ALL_SCHEDULES_SENTINEL, label: allTasksLabel },
      ...scheduleData.workSchedules.filter(s => s.kind === 'WorkSchedule').map(s => ({ // 'WorkPlan' never controls tasks directly
        value: s.globalId,
        label: s.name || s.globalId,
      })),
    ];
  }, [scheduleData, allTasksLabel]);

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
        <IconButton
          label={t('schedule.toolbar.jumpToStart')}
          size="icon-sm"
          onClick={goStart}
          disabled={!hasData}
        >
          <SkipBack className="h-4 w-4" />
        </IconButton>

        <IconButton
          label={isPlaying ? t('schedule.toolbar.pause') : t('schedule.toolbar.play')}
          tooltip={isPlaying ? t('schedule.toolbar.pauseConstructionSequence') : t('schedule.toolbar.playConstructionSequence')}
          size="icon-sm"
          variant={isPlaying ? 'default' : 'ghost'}
          onClick={togglePlay}
          disabled={!hasData}
        >
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </IconButton>

        <IconButton
          label={t('schedule.toolbar.jumpToFinish')}
          size="icon-sm"
          onClick={goEnd}
          disabled={!hasData}
        >
          <SkipForward className="h-4 w-4" />
        </IconButton>

        <IconButton
          label={playbackLoop ? t('schedule.toolbar.disableLoop') : t('schedule.toolbar.enableLoop')}
          tooltip={playbackLoop ? t('schedule.toolbar.looping') : t('schedule.toolbar.oneShot')}
          size="icon-sm"
          variant={playbackLoop ? 'default' : 'ghost'}
          onClick={() => setLoop(!playbackLoop)}
        >
          {playbackLoop ? <Repeat className="h-4 w-4" /> : <Repeat2 className="h-4 w-4" />}
        </IconButton>
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
          aria-label={t('schedule.toolbar.playbackPosition')}
        />
        <span className="text-xs text-muted-foreground font-mono whitespace-nowrap">
          {hasData ? formatLocaleDate(locale, playbackTime, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}
        </span>
      </div>

      {/* Work schedule dropdown */}
      <div className="flex items-center gap-1">
        <Calendar className="h-4 w-4 text-muted-foreground" />
        <Select value={selectedScheduleValue} onValueChange={handleScheduleChange}>
          <SelectTrigger className="h-8 w-[180px] text-xs">
            <SelectValue placeholder={t('schedule.toolbar.allTasks')} />
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
          <TooltipContent>{t('schedule.toolbar.simulationSpeed')}</TooltipContent>
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
                {t(opt.labelKey, { count: opt.quantity, value: formatLocaleNumber(locale, opt.quantity) })}
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
              {t(opt.labelKey)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Generate from spatial hierarchy */}
      {onOpenGenerate && (
        <IconButton
          label={t('schedule.toolbar.generateConstructionSchedule')}
          tooltip={canGenerate ? t('schedule.toolbar.generateScheduleEllipsis') : t('schedule.toolbar.noSpatialHierarchy')}
          size="icon-sm"
          onClick={onOpenGenerate}
          disabled={!canGenerate}
        >
          <CalendarPlus className="h-4 w-4" />
        </IconButton>
      )}

      {/* Import from MS Project (MSPDI XML) or a Gantt CSV export */}
      {onOpenImport && (
        <IconButton
          label={t('schedule.toolbar.importScheduleFromFile')}
          tooltip={t('schedule.toolbar.importScheduleTooltip')}
          size="icon-sm"
          onClick={onOpenImport}
        >
          <Upload className="h-4 w-4" />
        </IconButton>
      )}

      {/* + Task — insert a new task after the currently-selected row
          (or at the end when none is selected). Auto-selects the new
          task so the Inspector's Task card lights up for rename. */}
      {hasData && (
        <IconButton
          label={t('schedule.toolbar.addTask')}
          tooltip={t('schedule.toolbar.addTaskTooltip')}
          size="icon-sm"
          onClick={() => {
            const afterGlobalId = selectedTaskGlobalIds.size === 1
              ? selectedTaskGlobalIds.values().next().value
              : undefined;
            addTaskAction({ afterGlobalId });
          }}
        >
          <Plus className="h-4 w-4" />
        </IconButton>
      )}

      {/* Undo / Redo for schedule edits. Gated on stack depth so the
          buttons only appear when there's actually something to undo —
          avoids a persistent greyed-out pair on clean schedules. */}
      {(undoDepth > 0 || redoDepth > 0) && (
        <div className="flex items-center gap-1">
          <IconButton
            label={t('schedule.toolbar.undoScheduleEdit')}
            tooltip={t('schedule.toolbar.undoTooltip')}
            size="icon-sm"
            onClick={undoScheduleEdit}
            disabled={undoDepth === 0}
          >
            <Undo2 className="h-4 w-4" />
          </IconButton>
          <IconButton
            label={t('schedule.toolbar.redoScheduleEdit')}
            tooltip={t('schedule.toolbar.redoTooltip')}
            size="icon-sm"
            onClick={redoScheduleEdit}
            disabled={redoDepth === 0}
          >
            <Redo2 className="h-4 w-4" />
          </IconButton>
        </div>
      )}

      {/* Discard pending generated schedule — only visible when at least
          one locally-generated task exists. Keeps extracted tasks intact
          so partial-authoring workflows can still revert just the
          pending tail. */}
      {pendingGeneratedCount > 0 && (
        <IconButton
          label={t('schedule.toolbar.discardPendingAriaLabel', localizedCount(locale, pendingGeneratedCount))}
          tooltip={t('schedule.toolbar.discardPendingTooltip', localizedCount(locale, pendingGeneratedCount))}
          size="icon-sm"
          onClick={() => {
            const removed = clearGeneratedSchedule();
            if (removed > 0) {
              toast.success(t('schedule.toolbar.discardedToast', localizedCount(locale, removed)));
            }
          }}
          className="text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300"
        >
          <Trash2 className="h-4 w-4" />
        </IconButton>
      )}

      {/* Animation settings popover (replaces the bare toggle — gives the
          user access to lifecycle colour / palette / preparation window). */}
      <AnimationSettingsPopover
        animationEnabled={animationEnabled}
        onToggleAnimation={() => setAnimationEnabled(!animationEnabled)}
      />

      {hasData && !hasDates && (
        <span className="text-xs text-amber-500 whitespace-nowrap" title={t('schedule.toolbar.noDatesTitle')}>
          {t('schedule.toolbar.noDates')}
        </span>
      )}
    </div>
  );
}
