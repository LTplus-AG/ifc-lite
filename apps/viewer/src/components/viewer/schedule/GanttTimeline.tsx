/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GanttTimeline — right pane SVG timeline. Renders tick header, task bars,
 * milestone diamonds, dependency arrows, and the playback cursor.
 */

import { memo, useMemo, useCallback, useRef, useLayoutEffect, useState } from 'react';
import { CalendarOff } from 'lucide-react';
import type { ScheduleExtraction } from '@ifc-lite/parser';
import { cn } from '@/lib/utils';
import { useViewerStore, taskStartEpoch, taskFinishEpoch } from '@/store';
import type { GanttTimeScale, ScheduleTimeRange } from '@/store';
import { useTranslation } from '@/i18n';
import { formatLocaleDate } from '@/i18n/intlFormat';
import { IconButton } from '@/components/ui/icon-button';
import type { FlattenedTask } from './schedule-utils';
import {
  computeTicks,
  advanceCalendarTime,
  formatTickLabel,
  timeToX,
} from './schedule-utils';
import { GANTT_ROW_HEIGHT, GANTT_HEADER_HEIGHT } from './GanttTaskTree';
import { useGanttBarDrag } from './useGanttBarDrag';
import { GanttTaskBar } from './GanttTaskBar';
import { GanttDependencyArrows } from './GanttDependencyArrows';
import { GanttDragTooltip } from './GanttDragTooltip';
import { resolveActiveCalendar, getNonWorkingDayStarts, nextLocalDayStart } from './work-calendar';

// Alias kept for local readability; binds to the shared constant so the
// timeline header and the task-tree header stay the same height.
const HEADER_HEIGHT = GANTT_HEADER_HEIGHT;

interface GanttTimelineProps {
  rows: FlattenedTask[];
  data: ScheduleExtraction;
  range: ScheduleTimeRange;
  scale: GanttTimeScale;
  playbackTime: number;
  selectedGlobalIds: Set<string>;
  hoveredGlobalId: string | null;
  onSelect: (globalId: string, multi: boolean) => void;
  onHover: (globalId: string | null) => void;
  onScrubSeek: (time: number) => void;
  scrollTop: number;
  onScroll: (scrollTop: number) => void;
}

export const GanttTimeline = memo(function GanttTimeline({
  rows,
  data,
  range,
  scale,
  playbackTime,
  selectedGlobalIds,
  hoveredGlobalId,
  onSelect,
  onHover,
  onScrubSeek,
  scrollTop,
  onScroll,
}: GanttTimelineProps) {
  const { t, locale } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [pixelWidth, setPixelWidth] = useState(1000);

  // Drag state machine for bar shift / resize. Returned `live` drives
  // the floating tooltip rendered below the timeline SVG.
  const barDrag = useGanttBarDrag({ range, pixelWidth, scale });

  /**
   * Minimum pixels per time-scale unit. When the schedule spans more units
   * than the container can show at this density, we grow the SVG past the
   * pane width and the container scrolls horizontally — instead of
   * squeezing bars into unreadable 2-pixel stripes with overlapping tick
   * labels. Tuned so "Week" scale gives ~80 px per week (readable labels,
   * click-accurate bars) and larger scales get proportionally more.
   */
  const MIN_PX_PER_TICK: Record<GanttTimeScale, number> = {
    hour: 40,
    day: 60,
    week: 80,
    month: 100,
    year: 140,
  };
  const MS_PER_TICK_FOR_SCALE: Record<GanttTimeScale, number> = {
    hour: 3_600_000,
    day: 86_400_000,
    week: 7 * 86_400_000,
    month: 30 * 86_400_000,
    year: 365 * 86_400_000,
  };

  // Resize observer keeps pixelWidth synced with the right pane width, but
  // grows when the schedule is too long to fit at the configured density.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const recompute = () => {
      const span = Math.max(1, range.end - range.start);
      const tickMs = MS_PER_TICK_FOR_SCALE[scale];
      const minPerTick = MIN_PX_PER_TICK[scale];
      const required = Math.ceil((span / tickMs) * minPerTick);
      setPixelWidth(Math.max(200, el.clientWidth, required));
    };
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    recompute();
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start, range.end, scale]);

  const ticks = useMemo(
    () => computeTicks(range.start, range.end, scale),
    [range, scale],
  );

  // Non-working-day shading (#4830). `respectWorkCalendar` is the same flag
  // the playback clock (`advancePlaybackBy`, `playbackSlice.ts`) uses to
  // skip these days during auto-play — one flag, two consumers, so toggling
  // it off both stops the clock-skip AND clears the shading in one action.
  const respectWorkCalendar = useViewerStore(s => s.respectWorkCalendar);
  const setRespectWorkCalendar = useViewerStore(s => s.setRespectWorkCalendar);
  const activeWorkScheduleId = useViewerStore(s => s.activeWorkScheduleId);
  const activeCalendar = useMemo(
    () => resolveActiveCalendar(data, activeWorkScheduleId),
    [data, activeWorkScheduleId],
  );
  // Day-granularity shading only reads cleanly at day/week zoom — at
  // month/year scale a 1-day rect is sub-pixel and just adds SVG nodes.
  const dayShadingScale = scale === 'day' || scale === 'week';
  const nonWorkingDayStarts = useMemo(() => {
    if (!respectWorkCalendar || !dayShadingScale || !activeCalendar) return [];
    return getNonWorkingDayStarts(activeCalendar, range.start, range.end);
  }, [respectWorkCalendar, dayShadingScale, activeCalendar, range.start, range.end]);

  const rowsHeight = rows.length * GANTT_ROW_HEIGHT;

  /** Pre-compute per-task y-row lookup for sequence arrows. */
  const taskRowIndex = useMemo(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) m.set(rows[i].task.globalId, i);
    return m;
  }, [rows]);

  /**
   * Memoize `{ start, finish }` epoch tuples per task. The rAF playback loop
   * writes `playbackTime` on every frame (~60 Hz), so re-parsing ISO
   * datetimes / running the duration regex inside the `rows.map` was showing
   * up as a hot path for schedules with hundreds of rows. Recompute only when
   * the rows themselves change (task adds / reorders / schedule reloads).
   */
  const taskEpochs = useMemo(() => {
    const m = new Map<string, { start: number | undefined; finish: number | undefined }>();
    for (const row of rows) {
      m.set(row.task.globalId, {
        start: taskStartEpoch(row.task),
        finish: taskFinishEpoch(row.task),
      });
    }
    return m;
  }, [rows]);

  const cursorX = useMemo(
    () => timeToX(playbackTime, range.start, range.end, pixelWidth),
    [playbackTime, range, pixelWidth],
  );

  const handleContainerScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    onScroll(e.currentTarget.scrollTop);
  }, [onScroll]);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (el.scrollTop !== scrollTop) {
      el.scrollTop = scrollTop;
    }
  }, [scrollTop]);

  const handleTimelineClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const target = e.currentTarget;
    const rect = target.getBoundingClientRect();
    // `rect.left` tracks the svg's visible left edge, which shifts when the
    // container scrolls horizontally. Re-anchor to the SVG origin by adding
    // the scroll offset — keeps click→time mapping correct once horizontal
    // zoom produces overflow. No-op today because pixelWidth === clientWidth.
    const scrollLeft = containerRef.current?.scrollLeft ?? 0;
    const x = e.clientX - rect.left + scrollLeft;
    const pct = Math.min(1, Math.max(0, x / pixelWidth));
    onScrubSeek(range.start + pct * (range.end - range.start));
  }, [pixelWidth, range, onScrubSeek]);

  const handleTimelineKeyDown = useCallback((event: React.KeyboardEvent<SVGSVGElement>) => {
    let nextTime: number;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown': nextTime = advanceCalendarTime(playbackTime, scale, -1); break;
      case 'ArrowRight':
      case 'ArrowUp': nextTime = advanceCalendarTime(playbackTime, scale, 1); break;
      case 'Home': nextTime = range.start; break;
      case 'End': nextTime = range.end; break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    onScrubSeek(Math.min(range.end, Math.max(range.start, nextTime)));
  }, [playbackTime, scale, range, onScrubSeek]);

  const clampedPlaybackTime = Math.min(range.end, Math.max(range.start, playbackTime));

  return (
    <div
      ref={containerRef}
      className="h-full overflow-auto relative bg-gradient-to-b from-muted/10 to-transparent"
      onScroll={handleContainerScroll}
      data-testid="gantt-timeline"
    >
      {/* Sticky header */}
      <div
        className="sticky top-0 z-10 bg-card/90 backdrop-blur-sm border-b"
        style={{ height: HEADER_HEIGHT }}
      >
        {(data.workCalendars?.length ?? 0) > 0 && (
          <IconButton
            label={t('gantt.workCalendar.toggle.ariaLabel')}
            tooltip={respectWorkCalendar ? t('gantt.workCalendar.toggle.tooltipOn') : t('gantt.workCalendar.toggle.tooltipOff')}
            tooltipSide="bottom"
            variant={respectWorkCalendar ? 'secondary' : 'ghost'}
            className="absolute right-1 top-0.5 h-5 w-5 z-20"
            aria-pressed={respectWorkCalendar}
            onClick={() => setRespectWorkCalendar(!respectWorkCalendar)}
          >
            <CalendarOff className="h-3 w-3" />
          </IconButton>
        )}
        <svg width={pixelWidth} height={HEADER_HEIGHT} className="block">
          {ticks.map((t, i) => {
            const x = timeToX(t, range.start, range.end, pixelWidth);
            return (
              <g key={`t-${i}`}>
                <line x1={x} y1={0} x2={x} y2={HEADER_HEIGHT} stroke="currentColor" strokeOpacity={0.15} />
                <text
                  x={x + 3}
                  y={HEADER_HEIGHT - 8}
                  className="text-[10px] fill-muted-foreground font-mono"
                >
                  {formatTickLabel(t, scale)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Timeline body */}
      <svg
        width={pixelWidth}
        height={rowsHeight}
        className="block cursor-crosshair"
        onClick={handleTimelineClick}
        onKeyDown={handleTimelineKeyDown}
        role="slider"
        tabIndex={0}
        aria-label={t('schedule.toolbar.playbackPosition')}
        aria-valuemin={range.start}
        aria-valuemax={range.end}
        aria-valuenow={clampedPlaybackTime}
        aria-valuetext={formatLocaleDate(locale, clampedPlaybackTime, { dateStyle: 'medium', timeStyle: 'short' })}
      >
        {/* Non-working-day shading (#4830) — painted first so grid lines,
            row highlights and bars all draw on top of it. */}
        {nonWorkingDayStarts.map((dayStart) => {
          const x0 = timeToX(dayStart, range.start, range.end, pixelWidth);
          const x1 = timeToX(nextLocalDayStart(dayStart), range.start, range.end, pixelWidth);
          return (
            <rect
              key={`nwd-${dayStart}`}
              x={x0}
              y={0}
              width={Math.max(0, x1 - x0)}
              height={rowsHeight}
              fill="currentColor"
              fillOpacity={0.05}
              className="text-foreground pointer-events-none"
              data-testid="gantt-non-working-day"
            />
          );
        })}

        {/* Vertical grid */}
        {ticks.map((t, i) => {
          const x = timeToX(t, range.start, range.end, pixelWidth);
          return (
            <line
              key={`g-${i}`}
              x1={x}
              y1={0}
              x2={x}
              y2={rowsHeight}
              stroke="currentColor"
              strokeOpacity={0.08}
            />
          );
        })}

        {/* Row backgrounds + hover/selection highlight */}
        {rows.map((row, i) => {
          const y = i * GANTT_ROW_HEIGHT;
          const isSel = selectedGlobalIds.has(row.task.globalId);
          const isHov = hoveredGlobalId === row.task.globalId;
          const highlight = isSel ? 'rgba(99, 102, 241, 0.14)' : isHov ? 'rgba(148, 148, 148, 0.09)' : 'transparent';
          return (
            <rect
              key={`bg-${row.task.globalId}`}
              x={0}
              y={y}
              width={pixelWidth}
              height={GANTT_ROW_HEIGHT}
              fill={highlight}
              onMouseEnter={() => onHover(row.task.globalId)}
              onMouseLeave={() => onHover(null)}
            />
          );
        })}

        {/* Dependency arrows (drawn before bars so bars overlap) */}
        <GanttDependencyArrows
          sequences={data.sequences}
          taskRowIndex={taskRowIndex}
          taskEpochs={taskEpochs}
          rangeStart={range.start}
          rangeEnd={range.end}
          pixelWidth={pixelWidth}
        />

        {/* Task bars — use the memoized taskEpochs map so we don't re-parse
            ISO datetimes on every playback tick. */}
        {rows.map((row, i) => {
          const { task } = row;
          const epochs = taskEpochs.get(task.globalId);
          const start = epochs?.start;
          const finish = epochs?.finish;
          if (start === undefined || finish === undefined) return null;
          return (
            <GanttTaskBar
              key={task.globalId}
              task={task}
              rowIndex={i}
              start={start}
              finish={finish}
              rangeStart={range.start}
              rangeEnd={range.end}
              pixelWidth={pixelWidth}
              playbackTime={playbackTime}
              isSelected={selectedGlobalIds.has(task.globalId)}
              isDragging={barDrag.live.taskGlobalId === task.globalId}
              onHover={onHover}
              onSelect={onSelect}
              onPointerDown={barDrag.onPointerDown}
            />
          );
        })}

        {/* Playback cursor */}
        <line
          x1={cursorX}
          y1={0}
          x2={cursorX}
          y2={rowsHeight}
          stroke="#0ea5e9"
          strokeWidth={1.5}
          strokeDasharray="4 2"
          className={cn('pointer-events-none drop-shadow')}
        />
      </svg>

      {/* Live-drag tooltip — floats next to the cursor, absolute-
          positioned inside the scroll container so it scrolls with
          everything else. Only visible while a drag is active. */}
      {barDrag.live.taskGlobalId && (
        <GanttDragTooltip live={barDrag.live} />
      )}
    </div>
  );
});
