/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Serialize a `ScheduleExtraction` to IFC4-conformant STEP entity lines.
 *
 * The output is a list of `#N=IFC...(...);` lines (no preamble, no
 * `DATA;`/`ENDSEC;` framing) ready to be spliced into an existing STEP file
 * just before its terminating `ENDSEC;`. Every emitted entity carries:
 *
 *   • a freshly minted express ID starting at `nextId` (the caller computes
 *     `max(existing IDs) + 1`),
 *   • a 22-character GlobalId — the one already on the `ScheduleExtraction`
 *     when set, otherwise generated,
 *   • a reference to the supplied `ownerHistoryId` for IfcRoot ownership
 *     (pass `undefined` to emit `$`),
 *   • IFC4-correct attribute counts and ordering — IfcWorkSchedule,
 *     IfcTask + IfcTaskTime, IfcWorkCalendar + IfcWorkTime +
 *     IfcRecurrencePattern + IfcTimePeriod, IfcRelSequence + IfcLagTime,
 *     and the IfcRelAssignsToControl / IfcRelAssignsToProcess /
 *     IfcRelAssignsToProduct / IfcRelNests edges.
 *
 * The function is pure — it doesn't mutate the input and never touches the
 * STEP source buffer. Re-running it with the same inputs produces the same
 * output (deterministic), which keeps round-trip exports stable and makes
 * unit tests simple.
 *
 * The low-level STEP string encoding and the per-entity line builders
 * (`buildWorkControl`, `buildTaskTime`, `buildTask`, …) live in
 * `schedule-serializer-builders.ts`, with the calendar-side builders
 * (`buildWorkCalendar`, `buildWorkTime`) in
 * `schedule-serializer-calendar-builders.ts` — this file owns only the orchestration:
 * which entities and relationships to emit, in what order, and how their
 * express IDs cross-reference each other.
 */

import type { ScheduleExtraction, ScheduleSequenceInfo } from './schedule-extractor.js';
import { secondsToIso8601Duration } from './iso8601-duration.js';
import { deterministicGlobalId } from './deterministic-global-id.js';
import {
  escStr,
  optStr,
  optEnum,
  ownerRef,
  refList,
  ensureGlobalId,
  buildWorkControl,
  taskHasTimeData,
  buildTaskTime,
  buildTask,
  resolveProductIds,
  resolveProductId,
} from './schedule-serializer-builders.js';
import { buildWorkCalendar } from './schedule-serializer-calendar-builders.js';

export interface SerializeScheduleOptions {
  /** First free express ID for the synthesized entities. */
  nextId: number;
  /**
   * Express ID of an existing `IfcOwnerHistory` to reference, if the host
   * file has one. When omitted, every emitted entity uses `$` for ownership.
   */
  ownerHistoryId?: number;
  /**
   * Look up an existing express ID for a product GlobalId (for binding
   * `IfcRelAssignsToProcess.RelatedObjects` and
   * `IfcRelAssignsToProduct.RelatingProduct`). When omitted, or when it
   * returns `undefined`, the product's own positive expressId is used; a
   * product with neither is skipped — the schedule is still valid IFC, just
   * without that product link.
   */
  resolveProductExpressId?: (productGlobalId: string) => number | undefined;
}

export interface SerializeScheduleResult {
  /** STEP entity lines (each terminated with `;`). */
  lines: string[];
  /** First express ID after the last entity emitted. */
  nextId: number;
  /** Statistics for diagnostics / preview UI. */
  stats: {
    workSchedules: number;
    tasks: number;
    taskTimes: number;
    sequences: number;
    lagTimes: number;
    assignsToControl: number;
    assignsToProcess: number;
    /** IfcRelAssignsToProduct edges (task outputs), one per output product. */
    assignsToProduct: number;
    relNests: number;
    /** IfcWorkCalendar entities emitted. */
    workCalendars: number;
    /** IfcWorkTime entities emitted across every calendar's working + exception lists. */
    workTimes: number;
    /** IfcRecurrencePattern entities emitted (one per IfcWorkTime that carried a pattern). */
    recurrencePatterns: number;
    /** IfcTimePeriod entities emitted from those patterns' TimePeriods lists. */
    timePeriods: number;
    /**
     * IfcRelAssignsToControl edges whose RelatingControl is a calendar.
     * Counted separately from `assignsToControl` (schedule -> tasks) so a
     * caller can tell the two relationship kinds apart in a preview.
     */
    calendarAssignments: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Public — serializeScheduleToStep
// ─────────────────────────────────────────────────────────────────────────

export function serializeScheduleToStep(
  data: ScheduleExtraction,
  options: SerializeScheduleOptions,
): SerializeScheduleResult {
  let nextId = options.nextId;
  const lines: string[] = [];
  const owner = ownerRef(options.ownerHistoryId);
  const stats = {
    workSchedules: 0,
    tasks: 0,
    taskTimes: 0,
    sequences: 0,
    lagTimes: 0,
    assignsToControl: 0,
    assignsToProcess: 0,
    assignsToProduct: 0,
    relNests: 0,
    workCalendars: 0,
    workTimes: 0,
    recurrencePatterns: 0,
    timePeriods: 0,
    calendarAssignments: 0,
  };

  /** ScheduleTaskInfo.globalId → fresh express ID we just allocated. */
  const taskExpressIdByGlobalId = new Map<string, number>();
  /** WorkScheduleInfo.globalId → fresh express ID we just allocated. */
  const scheduleExpressIdByGlobalId = new Map<string, number>();
  /** WorkCalendarInfo.globalId → fresh express ID we just allocated. */
  const calendarExpressIdByGlobalId = new Map<string, number>();

  // ── 1. Work schedules / work plans ────────────────────────────────
  for (const ws of data.workSchedules) {
    const id = nextId++;
    scheduleExpressIdByGlobalId.set(ws.globalId, id);
    lines.push(buildWorkControl(id, ws, owner));
    stats.workSchedules += 1;
  }

  // ── 1b. Work calendars (+ their IfcWorkTime / IfcRecurrencePattern /
  //        IfcTimePeriod entities) ────────────────────────────────────
  // Emitted before the tasks that reference them only for readability; the
  // IfcRelAssignsToControl edges in section 3b below are what actually bind
  // them, and STEP permits forward references either way.
  for (const cal of data.workCalendars ?? []) {
    const built = buildWorkCalendar(nextId, cal, owner);
    lines.push(...built.lines);
    nextId = built.nextId;
    calendarExpressIdByGlobalId.set(cal.globalId, built.calendarId);
    stats.workCalendars += 1;
    stats.workTimes += built.workTimes;
    stats.recurrencePatterns += built.recurrencePatterns;
    stats.timePeriods += built.timePeriods;
  }

  // ── 2. Task times + tasks ─────────────────────────────────────────
  for (const task of data.tasks) {
    let taskTimeId: number | undefined;
    if (taskHasTimeData(task)) {
      taskTimeId = nextId++;
      lines.push(buildTaskTime(taskTimeId, task));
      stats.taskTimes += 1;
    }
    const id = nextId++;
    taskExpressIdByGlobalId.set(task.globalId, id);
    lines.push(buildTask(id, task, owner, taskTimeId));
    stats.tasks += 1;
  }

  // ── 3. Schedule → tasks (IfcRelAssignsToControl) ──────────────────
  for (const ws of data.workSchedules) {
    const controlId = scheduleExpressIdByGlobalId.get(ws.globalId);
    if (controlId === undefined) continue;
    const taskIds: number[] = [];
    for (const taskGid of ws.taskGlobalIds) {
      const tid = taskExpressIdByGlobalId.get(taskGid);
      if (tid !== undefined) taskIds.push(tid);
    }
    if (taskIds.length === 0) continue;
    const relId = nextId++;
    const relGid = deterministicGlobalId(`rel-control|${ws.globalId}`);
    lines.push(
      `#${relId}=IFCRELASSIGNSTOCONTROL('${relGid}',${owner},$,$,${refList(taskIds)},$,#${controlId});`,
    );
    stats.assignsToControl += 1;
  }

  // ── 3b. Calendar → tasks / schedules (IfcRelAssignsToControl) ─────
  // Mirrors section 3 above — same relation, RelatingControl an
  // IfcWorkCalendar instead of an IfcWorkSchedule. One relation per
  // calendar, its RelatedObjects the union of every task and schedule that
  // named this calendar, which is what the extractor reads back: a task
  // assigned to both a schedule and a calendar sees two separate relation
  // instances and populates both fields.
  for (const cal of data.workCalendars ?? []) {
    const controlId = calendarExpressIdByGlobalId.get(cal.globalId);
    if (controlId === undefined) continue;
    const relatedIds: number[] = [];
    for (const task of data.tasks) {
      if (!task.calendarGlobalIds?.includes(cal.globalId)) continue;
      const tid = taskExpressIdByGlobalId.get(task.globalId);
      if (tid !== undefined) relatedIds.push(tid);
    }
    for (const ws of data.workSchedules) {
      if (!ws.calendarGlobalIds?.includes(cal.globalId)) continue;
      const sid = scheduleExpressIdByGlobalId.get(ws.globalId);
      if (sid !== undefined) relatedIds.push(sid);
    }
    if (relatedIds.length === 0) continue;
    const relId = nextId++;
    const relGid = deterministicGlobalId(`rel-calendar|${cal.globalId}`);
    lines.push(
      `#${relId}=IFCRELASSIGNSTOCONTROL('${relGid}',${owner},$,$,${refList(relatedIds)},$,#${controlId});`,
    );
    stats.calendarAssignments += 1;
  }

  // ── 4. Task hierarchy (IfcRelNests) ──────────────────────────────
  for (const parent of data.tasks) {
    if (parent.childGlobalIds.length === 0) continue;
    const parentId = taskExpressIdByGlobalId.get(parent.globalId);
    if (parentId === undefined) continue;
    const childIds: number[] = [];
    for (const childGid of parent.childGlobalIds) {
      const cid = taskExpressIdByGlobalId.get(childGid);
      if (cid !== undefined) childIds.push(cid);
    }
    if (childIds.length === 0) continue;
    const relId = nextId++;
    const relGid = deterministicGlobalId(`rel-nests|${parent.globalId}`);
    lines.push(
      `#${relId}=IFCRELNESTS('${relGid}',${owner},$,$,#${parentId},${refList(childIds)});`,
    );
    stats.relNests += 1;
  }

  // ── 4b. Work-plan → work-schedule grouping (IfcRelNests) ──────────
  for (const plan of data.workSchedules) {
    // `?.length` treats `undefined` and `[]` the same — both mean "emit no
    // relation for this plan" — so any producer is free to use either for
    // "no schedules grouped", whether that's "deliberately none" or a field
    // it doesn't populate at all.
    if (plan.kind !== 'WorkPlan' || !plan.childScheduleGlobalIds?.length) continue;
    const parentId = scheduleExpressIdByGlobalId.get(plan.globalId);
    if (parentId === undefined) continue;
    const childIds: number[] = [];
    for (const childGid of plan.childScheduleGlobalIds) {
      const cid = scheduleExpressIdByGlobalId.get(childGid);
      if (cid !== undefined) childIds.push(cid);
    }
    if (childIds.length === 0) continue;
    const relId = nextId++;
    const relGid = deterministicGlobalId(`rel-nests-plan|${plan.globalId}`);
    lines.push(
      `#${relId}=IFCRELNESTS('${relGid}',${owner},$,$,#${parentId},${refList(childIds)});`,
    );
    stats.relNests += 1;
  }

  // ── 5. Products → tasks (IfcRelAssignsToProcess) ─────────────────
  for (const task of data.tasks) {
    if (task.productExpressIds.length === 0 && task.productGlobalIds.length === 0) continue;
    const taskId = taskExpressIdByGlobalId.get(task.globalId);
    if (taskId === undefined) continue;
    const productIds = resolveProductIds(task, options.resolveProductExpressId);
    if (productIds.length === 0) continue;
    const relId = nextId++;
    const relGid = deterministicGlobalId(`rel-process|${task.globalId}`);
    lines.push(
      `#${relId}=IFCRELASSIGNSTOPROCESS('${relGid}',${owner},$,$,${refList(productIds)},$,#${taskId},$);`,
    );
    stats.assignsToProcess += 1;
  }

  // ── 5b. Tasks → output products (IfcRelAssignsToProduct) ─────────
  // One relation per product, its RelatedObjects every task that outputs
  // it — the shape the buildingSMART construction-scheduling examples use,
  // and what the extractor reads back (#6749). Keyed by the resolved
  // express ID so two tasks naming the same product share one relation.
  const outputTasksByProduct = new Map<number, { taskIds: number[]; key: string }>();
  for (const task of data.tasks) {
    const outputIds = task.outputProductExpressIds ?? [];
    const outputGids = task.outputProductGlobalIds ?? [];
    const count = Math.max(outputIds.length, outputGids.length);
    if (count === 0) continue;
    const taskId = taskExpressIdByGlobalId.get(task.globalId);
    if (taskId === undefined) continue;
    for (let i = 0; i < count; i++) {
      const productId = resolveProductId(outputIds[i], outputGids[i], options.resolveProductExpressId);
      if (productId === undefined) continue;
      let entry = outputTasksByProduct.get(productId);
      if (!entry) {
        entry = { taskIds: [], key: outputGids[i] || `#${productId}` };
        outputTasksByProduct.set(productId, entry);
      }
      if (!entry.taskIds.includes(taskId)) entry.taskIds.push(taskId);
    }
  }
  for (const [productId, { taskIds, key }] of outputTasksByProduct) {
    const relId = nextId++;
    const relGid = deterministicGlobalId(`rel-product|${key}`);
    lines.push(
      `#${relId}=IFCRELASSIGNSTOPRODUCT('${relGid}',${owner},$,$,${refList(taskIds)},$,#${productId});`,
    );
    stats.assignsToProduct += 1;
  }

  // ── 6. Sequences (IfcLagTime + IfcRelSequence) ───────────────────
  for (const seq of data.sequences) {
    const relatingId = taskExpressIdByGlobalId.get(seq.relatingTaskGlobalId);
    const relatedId = taskExpressIdByGlobalId.get(seq.relatedTaskGlobalId);
    if (relatingId === undefined || relatedId === undefined) continue;

    // Preserve lag (and lead) on export even when the upstream extractor
    // only knew the numeric seconds value (e.g. IFC2X3 round-trips where the
    // original IfcDuration string got dropped, or a schedule built in
    // memory that only ever set `timeLagSeconds`). `secondsToIso8601Duration`
    // is signed — a lead (negative `timeLagSeconds`) emits the ISO 8601-2
    // signed form (`-P2D`) rather than losing its sign or its magnitude. See
    // `iso8601-duration.ts` for why: a dropped or wrongly-signed lag is
    // silently lossy in our own round trip, which is the worse failure.
    const lagDuration =
      seq.timeLagDuration ??
      (seq.timeLagSeconds !== undefined ? secondsToIso8601Duration(seq.timeLagSeconds) : undefined);
    let lagRef = '$';
    if (lagDuration) {
      const lagId = nextId++;
      lines.push(
        `#${lagId}=IFCLAGTIME($,$,$,IFCDURATION('${escStr(lagDuration)}'),.WORKTIME.);`,
      );
      lagRef = `#${lagId}`;
      stats.lagTimes += 1;
    }
    const relId = nextId++;
    const seqGid = ensureGlobalId(seq.globalId, `rel-seq|${seq.relatingTaskGlobalId}|${seq.relatedTaskGlobalId}`);
    const seqType = optEnum(seq.sequenceType ?? 'FINISH_START');
    const userDef = optStr(seq.userDefinedSequenceType);
    lines.push(
      `#${relId}=IFCRELSEQUENCE('${seqGid}',${owner},$,$,#${relatingId},#${relatedId},${lagRef},${seqType},${userDef});`,
    );
    stats.sequences += 1;
  }

  return { lines, nextId, stats };
}
