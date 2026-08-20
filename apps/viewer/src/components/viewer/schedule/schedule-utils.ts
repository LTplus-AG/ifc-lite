/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Helpers for the Gantt UI — date formatting, tick generation, and the
 * task-tree flattener that feeds the virtualized list.
 */

import type { ScheduleExtraction, ScheduleTaskInfo } from '@ifc-lite/parser';
import type { GanttTimeScale } from '@/store';
import { taskStartEpoch, taskFinishEpoch } from '@/store';

export interface FlattenedTask {
  task: ScheduleTaskInfo;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/**
 * Longest `IfcTask --[IfcRelNests]--> IfcTask` parent/child chain either walk
 * below will follow. `childGlobalIds` / `parentGlobalId` are built straight
 * from the file's `IfcRelNests` graph (`schedule-extractor.ts`'s Pass 2),
 * which records every RelatingObject/RelatedObjects pair without checking for
 * a cycle — nothing in the schema forbids a task nesting its own ancestor. A
 * generous cap: real work breakdown structures are a handful of levels deep.
 */
const MAX_TASK_NEST_DEPTH = 64;

/**
 * Flatten a task tree into the display order used by the Gantt list,
 * honoring the current expanded set. Tasks without parents are treated as
 * roots; each root and its expanded descendants appear in depth-first order.
 *
 * `visited` is GLOBAL to one flatten, not path-scoped: a cyclic
 * `IfcRelNests` chain (task A nests B, B nests A) would otherwise recurse
 * until the stack overflows, and a legitimate diamond (one task nested under
 * two parents) would otherwise emit the row twice. A task already placed
 * keeps its first row and is skipped everywhere else, so the walk is always
 * finite even on malformed input.
 */
export function flattenTaskTree(
  data: ScheduleExtraction | null,
  expanded: Set<string>,
  filterScheduleGlobalId?: string,
): FlattenedTask[] {
  if (!data) return [];
  const taskByGlobalId = new Map<string, ScheduleTaskInfo>();
  for (const t of data.tasks) taskByGlobalId.set(t.globalId, t);

  /**
   * A task is in-scope when no schedule filter is active, or when it (or any
   * descendant) is controlled by the filter. Ancestors pass through so the
   * expand/collapse chain stays visible even when only a leaf matches.
   */
  const isVisibleForSchedule = (task: ScheduleTaskInfo): boolean => (
    !filterScheduleGlobalId
    || task.controllingScheduleGlobalIds.includes(filterScheduleGlobalId)
    || descendantsInSchedule(task, taskByGlobalId, filterScheduleGlobalId)
  );

  const result: FlattenedTask[] = [];
  const roots = data.tasks.filter(t => !t.parentGlobalId);
  const filteredRoots = roots.filter(isVisibleForSchedule);

  const visited = new Set<string>();
  const visit = (task: ScheduleTaskInfo, depth: number) => {
    if (visited.has(task.globalId) || depth > MAX_TASK_NEST_DEPTH) return;
    visited.add(task.globalId);
    const hasChildren = task.childGlobalIds.length > 0;
    const isExpanded = expanded.has(task.globalId);
    result.push({ task, depth, hasChildren, expanded: isExpanded });
    if (hasChildren && isExpanded) {
      for (const childGid of task.childGlobalIds) {
        const child = taskByGlobalId.get(childGid);
        // Reuse the same predicate so out-of-scope descendants don't leak
        // through an in-scope ancestor.
        if (child && isVisibleForSchedule(child)) visit(child, depth + 1);
      }
    }
  };
  for (const root of filteredRoots) visit(root, 0);

  // Tasks that are not reachable through IfcRelNests from any root — append
  // at depth 0 so they're not orphaned. Apply the same predicate so the
  // schedule filter is respected.
  for (const task of data.tasks) {
    if (visited.has(task.globalId)) continue;
    if (!isVisibleForSchedule(task)) continue;
    result.push({ task, depth: 0, hasChildren: false, expanded: false });
    visited.add(task.globalId);
  }

  return result;
}

/**
 * Whether `task` or any `IfcRelNests` descendant is controlled by
 * `scheduleGid`. `visited` guards a single call's own walk against the same
 * cyclic `childGlobalIds` graph {@link flattenTaskTree} guards against — each
 * top-level call gets a fresh set, which is enough: once a task's subtree is
 * fully explored and found not to contain `scheduleGid`, revisiting it via a
 * different path can only find the same answer again.
 */
function descendantsInSchedule(
  task: ScheduleTaskInfo,
  index: Map<string, ScheduleTaskInfo>,
  scheduleGid: string,
  visited: Set<string> = new Set(),
): boolean {
  if (visited.has(task.globalId)) return false;
  visited.add(task.globalId);
  for (const childGid of task.childGlobalIds) {
    const child = index.get(childGid);
    if (!child) continue;
    if (child.controllingScheduleGlobalIds.includes(scheduleGid)) return true;
    if (descendantsInSchedule(child, index, scheduleGid, visited)) return true;
  }
  return false;
}

/**
 * Compute evenly spaced tick marks across [start..end] matching the given
 * time scale. Returns tick timestamps in epoch ms.
 */
export function computeTicks(
  start: number,
  end: number,
  scale: GanttTimeScale,
): number[] {
  const ticks: number[] = [];
  if (end <= start) return [start];
  const startDate = new Date(start);

  const addTick = (t: number) => { if (t >= start && t <= end) ticks.push(t); };

  switch (scale) {
    case 'hour': {
      const step = 3_600_000;
      for (let t = Math.ceil(start / step) * step; t <= end; t += step) addTick(t);
      break;
    }
    case 'day': {
      const d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
      while (d.getTime() <= end) {
        addTick(d.getTime());
        d.setDate(d.getDate() + 1);
      }
      break;
    }
    case 'week': {
      const d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
      // Back up to the previous Monday (ISO week anchor).
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      while (d.getTime() <= end) {
        addTick(d.getTime());
        d.setDate(d.getDate() + 7);
      }
      break;
    }
    case 'month': {
      const d = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
      while (d.getTime() <= end) {
        addTick(d.getTime());
        d.setMonth(d.getMonth() + 1);
      }
      break;
    }
    case 'year': {
      const d = new Date(startDate.getFullYear(), 0, 1);
      while (d.getTime() <= end) {
        addTick(d.getTime());
        d.setFullYear(d.getFullYear() + 1);
      }
      break;
    }
  }
  // Always include endpoints for a clean label frame.
  if (ticks[0] !== start) ticks.unshift(start);
  if (ticks[ticks.length - 1] !== end) ticks.push(end);
  return ticks;
}

export function formatTickLabel(t: number, scale: GanttTimeScale): string {
  const d = new Date(t);
  switch (scale) {
    case 'hour':
      return `${d.getHours().toString().padStart(2, '0')}:00`;
    case 'day':
    case 'week':
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    case 'month':
      return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    case 'year':
      return String(d.getFullYear());
    default:
      return d.toLocaleDateString();
  }
}

export function formatDateTime(t: number | undefined): string {
  if (t === undefined) return '—';
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Map an epoch ms to an x pixel given the timeline bounds.
 */
export function timeToX(t: number, start: number, end: number, pixelWidth: number): number {
  if (end <= start) return 0;
  const clamped = Math.min(Math.max(t, start), end);
  return ((clamped - start) / (end - start)) * pixelWidth;
}

/**
 * Utility for task bars — returns their horizontal start/width in pixels.
 */
export function taskBarGeometry(
  task: ScheduleTaskInfo,
  rangeStart: number,
  rangeEnd: number,
  pixelWidth: number,
): { x: number; width: number } | null {
  const start = taskStartEpoch(task);
  const finish = taskFinishEpoch(task);
  if (start === undefined || finish === undefined) return null;
  const x = timeToX(start, rangeStart, rangeEnd, pixelWidth);
  const x2 = timeToX(finish, rangeStart, rangeEnd, pixelWidth);
  // Milestones have zero width — render as a diamond 10px wide; other tasks
  // get at least 2px so they don't disappear at very wide zoom-outs.
  const width = Math.max(task.isMilestone ? 0 : 2, x2 - x);
  return { x, width };
}

/**
 * Produce a short "5d" / "3h" / "2w" label from an ISO 8601 duration string.
 */
export function formatDurationShort(iso: string | undefined): string {
  if (!iso) return '—';
  const m = iso.match(/^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return iso;
  const [, y, mo, w, d, h, mi, s] = m;
  const parts: string[] = [];
  if (y) parts.push(`${y}y`);
  if (mo) parts.push(`${mo}mo`);
  if (w) parts.push(`${w}w`);
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (mi) parts.push(`${mi}m`);
  if (s) parts.push(`${s}s`);
  return parts.length ? parts.join(' ') : '—';
}
