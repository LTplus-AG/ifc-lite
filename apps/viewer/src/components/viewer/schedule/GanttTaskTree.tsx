/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GanttTaskTree — left pane showing the hierarchical task list with
 * expand/collapse chevrons, milestone diamond markers, and duration.
 */

import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, Diamond, CircleDot, Flag, GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FlattenedTask } from './schedule-utils';
import { formatDurationShort } from './schedule-utils';

export const GANTT_ROW_HEIGHT = 28;
/**
 * Height of the sticky column-header row. MUST match the timeline's tick
 * header so scroll-sync between the two panes lands on the same row —
 * otherwise the highlight band / task bars drift by one row.
 */
export const GANTT_HEADER_HEIGHT = 28;

interface GanttTaskTreeProps {
  rows: FlattenedTask[];
  selectedGlobalIds: Set<string>;
  hoveredGlobalId: string | null;
  onToggleExpand: (globalId: string) => void;
  onSelect: (globalId: string, multi: boolean) => void;
  /** Click on empty-space below the rows clears the selection. */
  onBackgroundClick?: () => void;
  /** User finished a drag — move the source row to the index of the target row. */
  onReorder?: (sourceGlobalId: string, targetIndex: number) => void;
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
  onBackgroundClick,
  onReorder,
  onHover,
  scrollTop,
  onScroll,
}: GanttTaskTreeProps) {
  // Drag-to-reorder state. Uses native HTML5 drag-and-drop for
  // accessibility (screen-readers can speak the cursor transitions)
  // and cross-browser reliability. `dropIndex` drives the horizontal
  // drop-indicator line between rows.
  const dragSourceRef = useRef<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
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

  /**
   * Click on the scroll container itself (not a row/cell/button) clears
   * the Gantt selection. Uses `e.currentTarget === e.target` so clicks
   * that bubble up from a row don't also fire deselect.
   */
  const handleContainerClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.currentTarget === e.target) onBackgroundClick?.();
  }, [onBackgroundClick]);

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto overflow-x-hidden border-r bg-background"
      onScroll={handleScroll}
      onClick={handleContainerClick}
      data-testid="gantt-task-tree"
    >
      {/*
        Sticky column header — mirrors the timeline's tick header so both
        scroll containers have identical content layouts and `scrollTop` sync
        lands on the same row.
      */}
      <div
        className="sticky top-0 z-10 bg-card/90 backdrop-blur-sm border-b flex items-center justify-between px-2 text-[10px] uppercase tracking-wide text-muted-foreground font-medium"
        style={{ height: GANTT_HEADER_HEIGHT }}
      >
        <span>Task</span>
        <span>Duration</span>
      </div>
      <div style={{ height: rows.length * GANTT_ROW_HEIGHT }}>
        {/*
          ARIA grid semantics: the table is a grid, each <tr> keeps its
          native/`row` role (so `aria-selected` is valid), and the focusable
          primary cell carries `tabIndex` + keyboard handlers. This keeps the
          chevron <button> as a real button (not nested inside a `button`).
        */}
        <table
          className="w-full text-xs border-collapse"
          role="grid"
          aria-multiselectable="true"
        >
          <tbody>
            {rows.map((row, rowIdx) => {
              const { task, depth, hasChildren, expanded } = row;
              const isSelected = selectedGlobalIds.has(task.globalId);
              const isHovered = hoveredGlobalId === task.globalId;
              const label = task.name || task.identification || task.globalId.slice(0, 8);
              const showDropAbove = onReorder && dropIndex === rowIdx;
              return (
                <tr
                  key={task.globalId}
                  role="row"
                  aria-selected={isSelected}
                  style={{ height: GANTT_ROW_HEIGHT }}
                  className={cn(
                    'border-b border-border/40 transition-colors select-none',
                    isSelected && 'bg-primary/15',
                    !isSelected && isHovered && 'bg-muted/60',
                    !isSelected && !isHovered && 'hover:bg-muted/40',
                    showDropAbove && 'border-t-2 border-t-primary',
                  )}
                  onMouseEnter={() => onHover(task.globalId)}
                  onMouseLeave={() => onHover(null)}
                  draggable={onReorder ? true : undefined}
                  onDragStart={onReorder ? (e) => {
                    dragSourceRef.current = task.globalId;
                    // dataTransfer must be set on Firefox for drag to fire.
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', task.globalId);
                  } : undefined}
                  onDragOver={onReorder ? (e) => {
                    if (!dragSourceRef.current || dragSourceRef.current === task.globalId) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setDropIndex(rowIdx);
                  } : undefined}
                  onDragLeave={onReorder ? () => {
                    if (dropIndex === rowIdx) setDropIndex(null);
                  } : undefined}
                  onDrop={onReorder ? (e) => {
                    e.preventDefault();
                    const src = dragSourceRef.current;
                    if (src && src !== task.globalId) onReorder(src, rowIdx);
                    dragSourceRef.current = null;
                    setDropIndex(null);
                  } : undefined}
                  onDragEnd={onReorder ? () => {
                    dragSourceRef.current = null;
                    setDropIndex(null);
                  } : undefined}
                >
                  <td
                    role="gridcell"
                    tabIndex={0}
                    aria-label={label}
                    className={cn(
                      'px-1 whitespace-nowrap overflow-hidden text-ellipsis cursor-pointer',
                      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
                    )}
                    style={{ paddingLeft: 4 + depth * 14 }}
                    onClick={(e) => onSelect(task.globalId, e.shiftKey || e.ctrlKey || e.metaKey)}
                    onKeyDown={(e) => {
                      // The cell handles its own key events; the nested
                      // chevron <button> retains native activation via
                      // `stopPropagation` inside its own handlers.
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      onSelect(task.globalId, e.shiftKey || e.ctrlKey || e.metaKey);
                    }}
                  >
                    <span className="inline-flex items-center gap-1 group">
                      {onReorder && (
                        <GripVertical
                          className="w-3 h-3 text-muted-foreground/30 group-hover:text-muted-foreground/70 transition-colors shrink-0"
                          aria-hidden
                        />
                      )}
                      {hasChildren ? (
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleExpand(task.globalId);
                          }}
                          onKeyDown={(e) => {
                            // Let the browser activate the button natively;
                            // don't let Enter/Space bubble and also trigger
                            // row selection in the parent cell.
                            if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
                          }}
                          className="w-4 h-4 flex items-center justify-center text-muted-foreground hover:text-foreground"
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
                        {label}
                      </span>
                    </span>
                  </td>
                  <td
                    role="gridcell"
                    className="px-2 text-muted-foreground font-mono text-right whitespace-nowrap"
                  >
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
