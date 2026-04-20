/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GanttTaskTree — left pane showing the hierarchical task list with
 * expand/collapse chevrons, milestone diamond markers, and duration.
 */

import { memo, useCallback, useLayoutEffect, useRef } from 'react';
import { ChevronRight, ChevronDown, Diamond, CircleDot, Flag } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FlattenedTask } from './schedule-utils';
import { formatDurationShort } from './schedule-utils';

export const GANTT_ROW_HEIGHT = 28;

interface GanttTaskTreeProps {
  rows: FlattenedTask[];
  selectedGlobalIds: Set<string>;
  hoveredGlobalId: string | null;
  onToggleExpand: (globalId: string) => void;
  onSelect: (globalId: string, multi: boolean) => void;
  onHover: (globalId: string | null) => void;
  scrollTop: number;
  onScroll: (scrollTop: number) => void;
}

export const GanttTaskTree = memo(function GanttTaskTree({
  rows,
  selectedGlobalIds,
  hoveredGlobalId,
  onToggleExpand,
  onSelect,
  onHover,
  scrollTop,
  onScroll,
}: GanttTaskTreeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    onScroll(e.currentTarget.scrollTop);
  }, [onScroll]);

  // Sync externally-controlled scrollTop (e.g. timeline → task tree alignment).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (el.scrollTop !== scrollTop) {
      el.scrollTop = scrollTop;
    }
  }, [scrollTop]);

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto overflow-x-hidden border-r bg-background"
      onScroll={handleScroll}
      data-testid="gantt-task-tree"
    >
      <div style={{ height: rows.length * GANTT_ROW_HEIGHT }}>
        <table className="w-full text-xs border-collapse">
          <tbody>
            {rows.map((row) => {
              const { task, depth, hasChildren, expanded } = row;
              const isSelected = selectedGlobalIds.has(task.globalId);
              const isHovered = hoveredGlobalId === task.globalId;
              return (
                <tr
                  key={task.globalId}
                  style={{ height: GANTT_ROW_HEIGHT }}
                  className={cn(
                    'border-b border-border/40 transition-colors cursor-pointer select-none',
                    isSelected && 'bg-primary/15',
                    !isSelected && isHovered && 'bg-muted/60',
                    !isSelected && !isHovered && 'hover:bg-muted/40',
                  )}
                  onMouseEnter={() => onHover(task.globalId)}
                  onMouseLeave={() => onHover(null)}
                  onClick={(e) => onSelect(task.globalId, e.shiftKey || e.ctrlKey || e.metaKey)}
                >
                  <td
                    className="px-1 whitespace-nowrap overflow-hidden text-ellipsis"
                    style={{ paddingLeft: 4 + depth * 14 }}
                  >
                    <span className="inline-flex items-center gap-1">
                      {hasChildren ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleExpand(task.globalId);
                          }}
                          className="w-4 h-4 flex items-center justify-center text-muted-foreground hover:text-foreground"
                          aria-label={expanded ? 'Collapse' : 'Expand'}
                        >
                          {expanded ? (
                            <ChevronDown className="w-3 h-3" />
                          ) : (
                            <ChevronRight className="w-3 h-3" />
                          )}
                        </button>
                      ) : (
                        <span className="w-4 h-4 inline-block" />
                      )}

                      {task.isMilestone ? (
                        <Diamond className="w-3 h-3 text-amber-500 fill-amber-500" />
                      ) : task.taskTime?.isCritical ? (
                        <Flag className="w-3 h-3 text-red-500 fill-red-500" />
                      ) : (
                        <CircleDot className="w-3 h-3 text-primary/70" />
                      )}

                      <span
                        className={cn(
                          'truncate',
                          task.isMilestone && 'font-semibold',
                          task.taskTime?.isCritical && 'text-red-600',
                        )}
                        title={task.name || task.globalId}
                      >
                        {task.name || task.identification || task.globalId.slice(0, 8)}
                      </span>
                    </span>
                  </td>
                  <td className="px-2 text-muted-foreground font-mono text-right whitespace-nowrap">
                    {formatDurationShort(task.taskTime?.scheduleDuration)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
});
