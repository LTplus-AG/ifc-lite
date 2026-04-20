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
  taskBarGeometry,
  formatDateTime,
} from './schedule-utils';
import { GANTT_ROW_HEIGHT, GANTT_HEADER_HEIGHT } from './GanttTaskTree';

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

  // Resize observer keeps pixelWidth synced with the right pane width.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setPixelWidth(Math.max(200, el.clientWidth));
    });
    ro.observe(el);
    setPixelWidth(Math.max(200, el.clientWidth));
    return () => ro.disconnect();
  }, []);

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
    const x = e.clientX - rect.left;
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
          tasks={data.tasks}
          rangeStart={range.start}
          rangeEnd={range.end}
          pixelWidth={pixelWidth}
        />

        {/* Task bars */}
        {rows.map((row, i) => {
          const { task } = row;
          const y = i * GANTT_ROW_HEIGHT;
          const geometry = taskBarGeometry(task, range.start, range.end, pixelWidth);
          const isActive = isTaskActive(task, playbackTime);
          const isDone = isTaskDone(task, playbackTime);
          const isPending = !isActive && !isDone;
          const isSel = selectedGlobalIds.has(task.globalId);
          const isCritical = task.taskTime?.isCritical ?? false;

          if (!geometry) return null;

          if (task.isMilestone) {
            const cx = geometry.x;
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
                  {formatDateTime(taskStartEpoch(task))}
                </title>
              </g>
            );
          }

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
              <rect
                x={geometry.x}
                y={y + 6}
                width={Math.max(2, geometry.width)}
                height={GANTT_ROW_HEIGHT - 12}
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
                stroke={isSel ? '#111827' : 'transparent'}
                strokeWidth={isSel ? 1.5 : 0}
              />
              {task.taskTime?.completion !== undefined && (
                <rect
                  x={geometry.x}
                  y={y + 6}
                  width={Math.max(0, geometry.width) * Math.min(1, Math.max(0, task.taskTime.completion / 100))}
                  height={GANTT_ROW_HEIGHT - 12}
                  rx={3}
                  ry={3}
                  fill="#111827"
                  fillOpacity={0.28}
                />
              )}
              <title>
                {task.name || task.globalId}
                {'\n'}
                {formatDateTime(taskStartEpoch(task))} → {formatDateTime(taskFinishEpoch(task))}
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
    </div>
  );
});

interface DependencyArrowsProps {
  sequences: ScheduleSequenceInfo[];
  taskRowIndex: Map<string, number>;
  tasks: ScheduleExtraction['tasks'];
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
  tasks,
  rangeStart,
  rangeEnd,
  pixelWidth,
}: DependencyArrowsProps) {
  const taskByGid = useMemo(() => {
    const m = new Map<string, ScheduleExtraction['tasks'][number]>();
    for (const t of tasks) m.set(t.globalId, t);
    return m;
  }, [tasks]);

  return (
    <g opacity={0.45}>
      {sequences.map((seq, i) => {
        const from = taskByGid.get(seq.relatingTaskGlobalId);
        const to = taskByGid.get(seq.relatedTaskGlobalId);
        if (!from || !to) return null;
        const rowFrom = taskRowIndex.get(from.globalId);
        const rowTo = taskRowIndex.get(to.globalId);
        if (rowFrom === undefined || rowTo === undefined) return null;
        const fromStart = taskStartEpoch(from);
        const fromFinish = taskFinishEpoch(from);
        const toStart = taskStartEpoch(to);
        const toFinish = taskFinishEpoch(to);
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

function isTaskActive(
  task: ScheduleExtraction['tasks'][number],
  t: number,
): boolean {
  const s = taskStartEpoch(task);
  const f = taskFinishEpoch(task);
  if (s === undefined || f === undefined) return false;
  return t >= s && t <= f;
}

function isTaskDone(
  task: ScheduleExtraction['tasks'][number],
  t: number,
): boolean {
  const f = taskFinishEpoch(task);
  if (f === undefined) return false;
  return t > f;
}
