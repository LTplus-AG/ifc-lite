/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GanttTaskBar — renders a single Gantt row's bar (or diamond for milestones)
 * plus its drag hit-zones and completion overlay. Extracted from
 * GanttTimeline so the orchestrator there stays focused on layout / ticks /
 * cursor / arrows.
 *
 * Memoized on its own props so panning the playback cursor across a
 * schedule with hundreds of rows doesn't re-diff every bar every frame.
 */

import { memo } from 'react';
import type { ScheduleTaskInfo } from '@ifc-lite/parser';
import { timeToX, formatDateTime } from './schedule-utils';
import { GANTT_ROW_HEIGHT } from './GanttTaskTree';

export interface GanttTaskBarProps {
  task: ScheduleTaskInfo;
  rowIndex: number;
  /** Task start as epoch ms (already parsed by the parent's taskEpochs map). */
  start: number;
  /** Task finish as epoch ms. */
  finish: number;
  rangeStart: number;
  rangeEnd: number;
  pixelWidth: number;
  playbackTime: number;
  isSelected: boolean;
  isDragging: boolean;
  onHover: (globalId: string | null) => void;
  onSelect: (globalId: string, multi: boolean) => void;
  onPointerDown: (
    e: React.PointerEvent<SVGElement>,
    taskGlobalId: string,
    mode: 'shift' | 'resize-start' | 'resize-finish',
  ) => void;
}

export const GanttTaskBar = memo(function GanttTaskBar({
  task,
  rowIndex,
  start,
  finish,
  rangeStart,
  rangeEnd,
  pixelWidth,
  playbackTime,
  isSelected,
  isDragging,
  onHover,
  onSelect,
  onPointerDown,
}: GanttTaskBarProps) {
  const y = rowIndex * GANTT_ROW_HEIGHT;
  const barX = timeToX(start, rangeStart, rangeEnd, pixelWidth);
  const barX2 = timeToX(finish, rangeStart, rangeEnd, pixelWidth);
  const barWidth = Math.max(task.isMilestone ? 0 : 2, barX2 - barX);

  const isActive = playbackTime >= start && playbackTime <= finish;
  const isDone = playbackTime > finish;
  const isPending = !isActive && !isDone;
  const isCritical = task.taskTime?.isCritical ?? false;

  if (task.isMilestone) {
    const cx = barX;
    const cy = y + GANTT_ROW_HEIGHT / 2;
    const s = 6;
    return (
      <g
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
          stroke={isSelected ? '#111827' : '#713f12'}
          strokeWidth={isSelected ? 1.5 : 1}
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

  return (
    <g
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
        stroke={isDragging ? '#0ea5e9' : isSelected ? '#111827' : 'transparent'}
        strokeWidth={isDragging ? 2 : isSelected ? 1.5 : 0}
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
        onPointerDown={(e) => onPointerDown(e, task.globalId, 'shift')}
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
            onPointerDown={(e) => onPointerDown(e, task.globalId, 'resize-start')}
          />
          <rect
            x={barX + barWidth - edgeZone}
            y={barTop}
            width={edgeZone}
            height={barH}
            fill="transparent"
            className="cursor-ew-resize"
            onPointerDown={(e) => onPointerDown(e, task.globalId, 'resize-finish')}
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
});
