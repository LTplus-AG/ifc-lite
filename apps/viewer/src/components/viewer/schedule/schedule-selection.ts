/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * schedule-selection — pure helpers for Gantt ↔ 3D viewport sync.
 *
 * Two public surfaces:
 *
 *  1. `collectProductLocalIdsForTasks` — given a set of Gantt-selected task
 *     globalIds, walk the task tree and return the *union* of every
 *     descendant task's `productExpressIds`. Selecting a parent row in the
 *     Gantt therefore isolates every leaf below it — matching the mental
 *     model that a WBS row represents "all the work under this heading".
 *
 *  2. `findTaskForProductGlobalId` — reverse lookup used by the viewport →
 *     Gantt sync: user clicks a product in 3D, we find the first task that
 *     claims it and highlight that row in the Gantt (expanding ancestors
 *     so the row is visible).
 *
 * All functions are pure and side-effect-free; the React hooks in
 * `useGanttSelection3DSync` / `useViewportToGanttSync` wire them into the
 * store.
 */

import type { ScheduleExtraction, ScheduleTaskInfo } from '@ifc-lite/parser';

/**
 * Walk the task graph starting at `rootGlobalIds`, collecting every
 * descendant task's LOCAL product expressIds (including each root itself).
 *
 * "Descendants" follows `task.childGlobalIds`. Cycles are defended against
 * via a visited set — schedule data from `extractScheduleOnDemand` is a
 * forest in practice, but we don't trust that at this boundary.
 *
 * Returns LOCAL expressIds. The caller federation-translates them via
 * `toGlobalIdFromModels` since the viewport operates on globals.
 */
export function collectProductLocalIdsForTasks(
  data: ScheduleExtraction | null,
  rootGlobalIds: Iterable<string>,
): Set<number> {
  const productIds = new Set<number>();
  if (!data || data.tasks.length === 0) return productIds;

  const byGlobalId = new Map<string, ScheduleTaskInfo>();
  for (const task of data.tasks) byGlobalId.set(task.globalId, task);

  const visited = new Set<string>();
  const queue: string[] = [];
  for (const g of rootGlobalIds) {
    if (byGlobalId.has(g) && !visited.has(g)) {
      queue.push(g);
      visited.add(g);
    }
  }

  while (queue.length > 0) {
    const gid = queue.shift()!;
    const task = byGlobalId.get(gid);
    if (!task) continue;
    for (const local of task.productExpressIds) {
      productIds.add(local);
    }
    for (const childGid of task.childGlobalIds) {
      if (!visited.has(childGid) && byGlobalId.has(childGid)) {
        visited.add(childGid);
        queue.push(childGid);
      }
    }
  }
  return productIds;
}

/**
 * Find the *first* task in the schedule whose product list contains the
 * given globalId (renderer-space / federated ID), returning its task
 * globalId plus the full ancestor chain so the Gantt can expand rows to
 * reveal it.
 *
 * Multi-task assignment is rare but happens — we return the first match in
 * `data.tasks` iteration order, which is a deterministic function of the
 * STEP file. Callers that need multi-match behaviour can layer on top.
 */
export interface TaskHitForProduct {
  /** globalId of the task that owns the product. */
  taskGlobalId: string;
  /** Ancestor task globalIds from root → direct parent (excludes the hit). */
  ancestorGlobalIds: string[];
}

export function findTaskForProductGlobalId(
  data: ScheduleExtraction | null,
  productGlobalId: number,
): TaskHitForProduct | null {
  if (!data || data.tasks.length === 0) return null;

  // Fast path: generated schedules populate `productGlobalIds` with the
  // renderer-space IDs, so we can string-match the number directly. For
  // extracted schedules the field may be empty — in that case we fall back
  // to a per-model local-id scan (not implemented here; the caller is
  // expected to have pre-translated productGlobalIds for extracted data).
  const productIdStr = String(productGlobalId);
  const hit = data.tasks.find(t => t.productGlobalIds.includes(productIdStr));
  if (!hit) return null;

  // Walk parent pointers to build the ancestor chain. `parentGlobalId` may
  // be absent for root tasks — we stop at the first missing link.
  const byGlobalId = new Map<string, ScheduleTaskInfo>();
  for (const task of data.tasks) byGlobalId.set(task.globalId, task);

  const ancestors: string[] = [];
  const seen = new Set<string>([hit.globalId]);
  let cursor = hit.parentGlobalId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    ancestors.unshift(cursor);
    const parent = byGlobalId.get(cursor);
    cursor = parent?.parentGlobalId;
  }

  return { taskGlobalId: hit.globalId, ancestorGlobalIds: ancestors };
}

/**
 * Reverse lookup that also handles extracted (non-generated) schedules,
 * which don't pre-populate `productGlobalIds`. The caller supplies a
 * `localFromGlobal(globalId) => localExpressId` federation translator.
 *
 * If the schedule is generated (has non-empty productGlobalIds), the
 * cheap string-match path inside `findTaskForProductGlobalId` wins and
 * this fallback is not reached.
 */
export function findTaskForProductGlobalIdWithLocal(
  data: ScheduleExtraction | null,
  productGlobalId: number,
  localFromGlobal: (globalId: number) => number | undefined,
): TaskHitForProduct | null {
  const fast = findTaskForProductGlobalId(data, productGlobalId);
  if (fast) return fast;
  if (!data) return null;

  const local = localFromGlobal(productGlobalId);
  if (local === undefined) return null;

  const hit = data.tasks.find(t => t.productExpressIds.includes(local));
  if (!hit) return null;

  const byGlobalId = new Map<string, ScheduleTaskInfo>();
  for (const task of data.tasks) byGlobalId.set(task.globalId, task);

  const ancestors: string[] = [];
  const seen = new Set<string>([hit.globalId]);
  let cursor = hit.parentGlobalId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    ancestors.unshift(cursor);
    const parent = byGlobalId.get(cursor);
    cursor = parent?.parentGlobalId;
  }

  return { taskGlobalId: hit.globalId, ancestorGlobalIds: ancestors };
}
