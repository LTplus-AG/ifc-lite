/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GanttTimeline — right pane SVG timeline. Renders tick header, task bars,
 * milestone diamonds, dependency arrows, and the playback cursor.
 */

import { memo, useMemo, useCallback, useRef, useLayoutEffect, useState } from 'react';
import type { ScheduleExtraction, ScheduleSequenceInfo } from '@ifc-lite/parser';
import { cn } from '@/lib/utils';
import { taskStartEpoch, taskFinishEpoch } from '@/store';
import type { GanttTimeScale, ScheduleTimeRange } from '@/store';
import type { FlattenedTask } from './schedule-utils';
import {
  computeTicks,
  formatTickLabel,
  timeToX,
  formatDateTime,
} from './schedule-utils';
import { GANTT_ROW_HEIGHT, GANTT_HEADER_HEIGHT } from './GanttTaskTree';
import { useGanttBarDrag } from './useGanttBarDrag';

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
      >
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
        <DependencyArrows
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

          const y = i * GANTT_ROW_HEIGHT;
          const barX = timeToX(start, range.start, range.end, pixelWidth);
          const barX2 = timeToX(finish, range.start, range.end, pixelWidth);
          const barWidth = Math.max(task.isMilestone ? 0 : 2, barX2 - barX);

          const isActive = playbackTime >= start && playbackTime <= finish;
          const isDone = playbackTime > finish;
          const isPending = !isActive && !isDone;
          const isSel = selectedGlobalIds.has(task.globalId);
          const isCritical = task.taskTime?.isCritical ?? false;

          if (task.isMilestone) {
            const cx = barX;
            const cy = y + GANTT_ROW_HEIGHT / 2;
            const s = 6;
            return (
              <g
                key={task.globalId}
                onMouseEnter={() => onHover(task.globalId)}
                onMouseLeave={() => onHover(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(task.globalId, e.shiftKey || e.ctrlKey || e.metaKey);
                }}
                className="cursor-pointer"
              >
                <polygon
                  points={`${cx},${cy - s} ${cx + s},${cy} ${cx},${cy + s} ${cx - s},${cy}`}
                  fill={isDone ? '#f59e0b' : isActive ? '#fbbf24' : '#94a3b8'}
                  stroke={isSel ? '#111827' : '#713f12'}
                  strokeWidth={isSel ? 1.5 : 1}
                />
                <title>
                  {task.name || task.globalId}
                  {'\n'}
                  {formatDateTime(start)}
                </title>
              </g>
            );
          }

          // Edge hit zones for resize. Minimum 4 px wide so we stay
          // clickable even on very short bars; capped at 25 % of the
          // bar width so on bars < 20 px the whole bar becomes a shift
          // zone (you can still resize via the Inspector).
          const edgeZone = Math.min(8, Math.max(4, Math.floor(barWidth * 0.25)));
          const showEdgeHandles = barWidth >= edgeZone * 2 + 4;
          const barTop = y + 6;
          const barH = GANTT_ROW_HEIGHT - 12;
          const isDragging = barDrag.live.taskGlobalId === task.globalId;

          return (
            <g
              key={task.globalId}
              onMouseEnter={() => onHover(task.globalId)}
              onMouseLeave={() => onHover(null)}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(task.globalId, e.shiftKey || e.ctrlKey || e.metaKey);
              }}
            >
              <rect
                x={barX}
                y={barTop}
                width={Math.max(2, barWidth)}
                height={barH}
                rx={3}
                ry={3}
                fill={
                  isCritical
                    ? isDone
                      ? '#dc2626'
                      : isActive
                        ? '#ef4444'
                        : '#7f1d1d'
                    : isDone
                      ? '#6366f1'
                      : isActive
                        ? '#818cf8'
                        : '#c7d2fe'
                }
                fillOpacity={isPending ? 0.55 : 0.95}
                stroke={isDragging ? '#0ea5e9' : isSel ? '#111827' : 'transparent'}
                strokeWidth={isDragging ? 2 : isSel ? 1.5 : 0}
              />
              {task.taskTime?.completion !== undefined && (
                <rect
                  x={barX}
                  y={barTop}
                  width={Math.max(0, barWidth) * Math.min(1, Math.max(0, task.taskTime.completion / 100))}
                  height={barH}
                  rx={3}
                  ry={3}
                  fill="#111827"
                  fillOpacity={0.28}
                  pointerEvents="none"
                />
              )}
              {/* Shift hit-zone: the interior of the bar. Draws no fill
                  (the visible fill rect above handles that) but owns the
                  pointer events that map to drag-body. */}
              <rect
                x={showEdgeHandles ? barX + edgeZone : barX}
                y={barTop}
                width={
                  showEdgeHandles
                    ? Math.max(1, barWidth - edgeZone * 2)
                    : Math.max(2, barWidth)
                }
                height={barH}
                fill="transparent"
                className="cursor-move"
                onPointerDown={(e) => barDrag.onPointerDown(e, task.globalId, 'shift')}
              />
              {/* Edge resize hit-zones. Only render when the bar is wide
                  enough for separate zones — otherwise the whole bar is
                  a shift zone and resize goes through the Inspector. */}
              {showEdgeHandles && (
                <>
                  <rect
                    x={barX}
                    y={barTop}
                    width={edgeZone}
                    height={barH}
                    fill="transparent"
                    className="cursor-ew-resize"
                    onPointerDown={(e) => barDrag.onPointerDown(e, task.globalId, 'resize-start')}
                  />
                  <rect
                    x={barX + barWidth - edgeZone}
                    y={barTop}
                    width={edgeZone}
                    height={barH}
                    fill="transparent"
                    className="cursor-ew-resize"
                    onPointerDown={(e) => barDrag.onPointerDown(e, task.globalId, 'resize-finish')}
                  />
                </>
              )}
              <title>
                {task.name || task.globalId}
                {'\n'}
                {formatDateTime(start)} → {formatDateTime(finish)}
              </title>
            </g>
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
        <DragTooltip live={barDrag.live} />
      )}
    </div>
  );
});

interface DragTooltipProps {
  live: { taskGlobalId: string | null; mode: 'shift' | 'resize-start' | 'resize-finish' | null; liveStartMs: number; liveFinishMs: number };
}

/**
 * Tiny fixed-position readout pinned near the top of the timeline during
 * a bar drag. Shows the proposed new start / finish / duration so the
 * user can see the commit target without staring at the bar itself.
 * Fixed positioning (not absolute) keeps it above any scroll; `top:60px`
 * anchors below the toolbar region.
 */
function DragTooltip({ live }: DragTooltipProps) {
  const durMs = Math.max(0, live.liveFinishMs - live.liveStartMs);
  const durDays = (durMs / 86_400_000).toFixed(2).replace(/\.?0+$/, '');
  const fmt = (ms: number) => {
    const d = new Date(ms);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };
  const modeLabel =
    live.mode === 'shift' ? 'Shifting'
    : live.mode === 'resize-start' ? 'Resizing start'
    : live.mode === 'resize-finish' ? 'Resizing finish'
    : '';
  return (
    <div
      className="fixed z-50 pointer-events-none top-16 left-1/2 -translate-x-1/2 rounded-md border border-sky-400 bg-sky-50 dark:bg-sky-950 dark:border-sky-700 px-3 py-1.5 shadow-lg text-[11px] font-mono text-sky-900 dark:text-sky-100"
      role="status"
      aria-live="polite"
    >
      <div className="font-sans text-[10px] uppercase tracking-wider opacity-70">{modeLabel}</div>
      <div>Start  {fmt(live.liveStartMs)}</div>
      <div>Finish {fmt(live.liveFinishMs)}</div>
      <div className="opacity-80">Duration {durDays}d</div>
      <div className="font-sans text-[9px] opacity-50 mt-0.5">Shift = no snap · Esc = cancel</div>
    </div>
  );
}

interface DependencyArrowsProps {
  sequences: ScheduleSequenceInfo[];
  taskRowIndex: Map<string, number>;
  /** Memoized { start, finish } per task globalId — avoids re-parsing ISO. */
  taskEpochs: Map<string, { start: number | undefined; finish: number | undefined }>;
  rangeStart: number;
  rangeEnd: number;
  pixelWidth: number;
}

/**
 * Renders IfcRelSequence dependencies as subtle orthogonal connectors between
 * the predecessor's finish and the successor's start (FS/SS/FF/SF).
 */
function DependencyArrows({
  sequences,
  taskRowIndex,
  taskEpochs,
  rangeStart,
  rangeEnd,
  pixelWidth,
}: DependencyArrowsProps) {
  return (
    <g opacity={0.45}>
      {sequences.map((seq, i) => {
        const fromEpochs = taskEpochs.get(seq.relatingTaskGlobalId);
        const toEpochs = taskEpochs.get(seq.relatedTaskGlobalId);
        const rowFrom = taskRowIndex.get(seq.relatingTaskGlobalId);
        const rowTo = taskRowIndex.get(seq.relatedTaskGlobalId);
        if (!fromEpochs || !toEpochs || rowFrom === undefined || rowTo === undefined) return null;
        const fromStart = fromEpochs.start;
        const fromFinish = fromEpochs.finish;
        const toStart = toEpochs.start;
        const toFinish = toEpochs.finish;
        if (
          fromStart === undefined || fromFinish === undefined ||
          toStart === undefined || toFinish === undefined
        ) return null;

        let x1 = 0, x2 = 0;
        switch (seq.sequenceType) {
          case 'START_START':
            x1 = timeToX(fromStart, rangeStart, rangeEnd, pixelWidth);
            x2 = timeToX(toStart, rangeStart, rangeEnd, pixelWidth);
            break;
          case 'FINISH_FINISH':
            x1 = timeToX(fromFinish, rangeStart, rangeEnd, pixelWidth);
            x2 = timeToX(toFinish, rangeStart, rangeEnd, pixelWidth);
            break;
          case 'START_FINISH':
            x1 = timeToX(fromStart, rangeStart, rangeEnd, pixelWidth);
            x2 = timeToX(toFinish, rangeStart, rangeEnd, pixelWidth);
            break;
          case 'FINISH_START':
          default:
            x1 = timeToX(fromFinish, rangeStart, rangeEnd, pixelWidth);
            x2 = timeToX(toStart, rangeStart, rangeEnd, pixelWidth);
            break;
        }
        const y1 = rowFrom * GANTT_ROW_HEIGHT + GANTT_ROW_HEIGHT / 2;
        const y2 = rowTo * GANTT_ROW_HEIGHT + GANTT_ROW_HEIGHT / 2;
        const midX = (x1 + x2) / 2;
        return (
          <path
            key={`seq-${i}`}
            d={`M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`}
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
            strokeDasharray="3 2"
            pointerEvents="none"
          />
        );
      })}
    </g>
  );
}

// Active / done predicates are now inlined into the row loop against the
// memoized `taskEpochs` map (above) — see the `rows.map(...)` block.
