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
import { Button } from '@/components/ui/button';
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
import { shortcutLabel } from '@/lib/commands/shortcut-label';

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
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={goStart}
              disabled={!hasData}
              aria-label={t('schedule.toolbar.jumpToStart')}
            >
              <SkipBack className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('schedule.toolbar.jumpToStart')}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant={isPlaying ? 'default' : 'ghost'}
              onClick={togglePlay}
              disabled={!hasData}
              aria-label={isPlaying ? t('schedule.toolbar.pause') : t('schedule.toolbar.play')}
            >
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{isPlaying ? t('schedule.toolbar.pauseConstructionSequence') : t('schedule.toolbar.playConstructionSequence')}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={goEnd}
              disabled={!hasData}
              aria-label={t('schedule.toolbar.jumpToFinish')}
            >
              <SkipForward className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('schedule.toolbar.jumpToFinish')}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant={playbackLoop ? 'default' : 'ghost'}
              onClick={() => setLoop(!playbackLoop)}
              aria-label={playbackLoop ? t('schedule.toolbar.disableLoop') : t('schedule.toolbar.enableLoop')}
            >
              {playbackLoop ? <Repeat className="h-4 w-4" /> : <Repeat2 className="h-4 w-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{playbackLoop ? t('schedule.toolbar.looping') : t('schedule.toolbar.oneShot')}</TooltipContent>
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
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={onOpenGenerate}
              disabled={!canGenerate}
              aria-label={t('schedule.toolbar.generateConstructionSchedule')}
            >
              <CalendarPlus className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{canGenerate ? t('schedule.toolbar.generateScheduleEllipsis') : t('schedule.toolbar.noSpatialHierarchy')}</TooltipContent>
        </Tooltip>
      )}

      {/* Import from MS Project (MSPDI XML) or a Gantt CSV export */}
      {onOpenImport && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={onOpenImport}
              aria-label={t('schedule.toolbar.importScheduleFromFile')}
            >
              <Upload className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('schedule.toolbar.importScheduleTooltip')}</TooltipContent>
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
              aria-label={t('schedule.toolbar.addTask')}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('schedule.toolbar.addTaskTooltip')}</TooltipContent>
        </Tooltip>
      )}

      {/* Undo / Redo for schedule edits, shown only when a stack is non-empty
          so a clean schedule has no persistent greyed-out pair. */}
      {(undoDepth > 0 || redoDepth > 0) && (
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={undoScheduleEdit}
                disabled={undoDepth === 0}
                aria-label={t('schedule.toolbar.undoScheduleEdit')}
              >
                <Undo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('schedule.toolbar.undoTooltip', { keys: shortcutLabel('schedule.undo') })}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={redoScheduleEdit}
                disabled={redoDepth === 0}
                aria-label={t('schedule.toolbar.redoScheduleEdit')}
              >
                <Redo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('schedule.toolbar.redoTooltip', { keys: shortcutLabel('schedule.redo') })}</TooltipContent>
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
                  toast.success(t('schedule.toolbar.discardedToast', localizedCount(locale, removed)));
                }
              }}
              aria-label={t('schedule.toolbar.discardPendingAriaLabel', localizedCount(locale, pendingGeneratedCount))}
              className="text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('schedule.toolbar.discardPendingTooltip', localizedCount(locale, pendingGeneratedCount))}</TooltipContent>
        </Tooltip>
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
