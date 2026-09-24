/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schedule (4D) extractor — walks IfcTask, IfcTaskTime, IfcRelSequence,
 * IfcRelAssignsToProcess, IfcRelAssignsToControl, IfcRelNests, IfcWorkSchedule,
 * IfcWorkPlan, IfcWorkCalendar, IfcLagTime entities in a parsed IfcDataStore
 * and assembles a normalized ScheduleExtraction that the viewer can drive a
 * Gantt/4D animation from.
 *
 * Handles IFC4 / IFC4X3. IFC2X3 has a different IfcTask layout (no TaskTime
 * attribute, ScheduleStart/ScheduleFinish/TaskOwner instead) and a different,
 * older IfcWorkCalendar layout; both are out of scope and best-effort
 * degrade (task metadata without dates; calendars simply aren't extracted).
 *
 * STEP attribute-index layouts, the record types themselves, and the small
 * pure/single-entity helpers live in `schedule-types.ts` (tasks/schedules)
 * and `schedule-calendar-types.ts` (calendars) — this file owns only the
 * cross-entity orchestration (the multi-pass walk below that wires those
 * records together via their IFC relationships); the calendar-assignment
 * half of that walk is in `schedule-control-extractor.ts`, split out
 * purely to keep this file under the ~400-line module-size guideline.
 */

import { CostEntityReader } from './cost-reader.js';
import type { CostMutationOverlay } from './cost-overlay.js';
import type { IfcDataStore } from './columnar-parser.js';
import { parseIso8601Duration } from './iso8601-duration.js';
import {
  TASK_ATTR,
  TASK_ATTR_2X3,
  REL_SEQUENCE_ATTR,
  REL_ASSIGNS_TO_PROCESS_ATTR,
  REL_ASSIGNS_TO_CONTROL_ATTR,
  REL_NESTS_ATTR,
  asString,
  asNumber,
  asBoolean,
  asEnum,
  asRef,
  asRefList,
  sequenceTypeFromString,
  extractTaskTime,
  extractLagTimeSeconds,
} from './schedule-types.js';
import type {
  SequenceTypeEnum,
  TaskDurationType,
  ScheduleTaskTimeInfo,
  ScheduleTaskInfo,
  ScheduleSequenceInfo,
  WorkScheduleInfo,
  ScheduleExtraction,
} from './schedule-types.js';
import {
  extractWorkScheduleInfo,
  extractWorkCalendars,
  tryAssignCalendar,
} from './schedule-control-extractor.js';

// Re-exported for backward compatibility — this is where consumers
// (including this package's own public surface, see index.ts) have always
// imported it from. The implementation itself now lives in
// `iso8601-duration.ts`, alongside its encode counterpart
// `secondsToIso8601Duration`, so the round-trip property between the two is
// visible in one place.
export { parseIso8601Duration };

// Re-exported so `import ... from './schedule-extractor.js'` (this
// package's public surface, see index.ts) still resolves every type it did
// before the schedule-types.ts split.
export type {
  SequenceTypeEnum,
  TaskDurationType,
  ScheduleTaskTimeInfo,
  ScheduleTaskInfo,
  ScheduleSequenceInfo,
  WorkScheduleInfo,
  ScheduleExtraction,
};

// Calendar types also resolve from here, alongside index.ts's own re-export.
export type { WorkCalendarInfo, WorkTimeInfo, RecurrencePatternInfo, TimePeriodInfo } from './schedule-calendar-types.js';

/**
 * Extract all scheduling data from a parsed IFC store.
 *
 * Walks every IfcTask / IfcTaskTime / IfcRelSequence / IfcRelAssignsToProcess /
 * IfcRelAssignsToControl / IfcRelNests / IfcWorkSchedule / IfcWorkPlan entity
 * and assembles a connected ScheduleExtraction.
 */
export function extractScheduleOnDemand(store: IfcDataStore, options?: { overlay?: CostMutationOverlay }): ScheduleExtraction {
  if (!store.source?.length && !options?.overlay) {
    return { workSchedules: [], tasks: [], sequences: [], workCalendars: [], hasSchedule: false };
  }

  // The same record reader used by cost extraction folds source edits, retypes,
  // tombstones and creations through export-equivalent STEP records.
  const reader = new CostEntityReader(store, options?.overlay);
  const taskIds = reader.ids('IFCTASK');
  const workScheduleIds = reader.ids('IFCWORKSCHEDULE');
  const workPlanIds = reader.ids('IFCWORKPLAN');
  const relSeqIds = reader.ids('IFCRELSEQUENCE');
  const relAssignsProcessIds = reader.ids('IFCRELASSIGNSTOPROCESS');
  const relAssignsControlIds = reader.ids('IFCRELASSIGNSTOCONTROL');
  const relNestsIds = reader.ids('IFCRELNESTS');
  const workCalendarIds = reader.ids('IFCWORKCALENDAR');

  // A calendar-only file (no tasks/schedules/sequences yet) still counts as
  // real 4D data worth surfacing, so it flips `hasAny`/`hasSchedule` exactly
  // like the other schedule entity types.
  const hasAny =
    taskIds.length +
      workScheduleIds.length +
      workPlanIds.length +
      relSeqIds.length +
      workCalendarIds.length >
    0;

  if (!hasAny) {
    return { workSchedules: [], tasks: [], sequences: [], workCalendars: [], hasSchedule: false };
  }

  const schemaIs2x3 = store.schemaVersion === 'IFC2X3';

  /** expressId -> task record (for cross-linking) */
  const taskByExpressId = new Map<number, ScheduleTaskInfo>();
  /** expressId -> globalId (for products & schedules & tasks) */
  const globalIdByExpressId = new Map<number, string>();

  // Pass 1: extract base IfcTask records.
  for (const expressId of taskIds) {
    const entity = reader.get(expressId);
    if (!entity) continue;
    const a = entity.attributes || [];

    if (schemaIs2x3) {
      const globalId = asString(a[TASK_ATTR_2X3.GlobalId]) ?? '';
      const task: ScheduleTaskInfo = {
        expressId,
        globalId,
        name: asString(a[TASK_ATTR_2X3.Name]) ?? '',
        description: asString(a[TASK_ATTR_2X3.Description]),
        objectType: asString(a[TASK_ATTR_2X3.ObjectType]),
        identification: asString(a[TASK_ATTR_2X3.TaskId]),
        status: asString(a[TASK_ATTR_2X3.Status]),
        workMethod: asString(a[TASK_ATTR_2X3.WorkMethod]),
        isMilestone: asBoolean(a[TASK_ATTR_2X3.IsMilestone]) ?? false,
        priority: asNumber(a[TASK_ATTR_2X3.Priority]),
        childGlobalIds: [],
        productExpressIds: [],
        productGlobalIds: [],
        controllingScheduleGlobalIds: [],
      };
      if (globalId) globalIdByExpressId.set(expressId, globalId);
      taskByExpressId.set(expressId, task);
    } else {
      const globalId = asString(a[TASK_ATTR.GlobalId]) ?? '';
      const taskTimeId = asRef(a[TASK_ATTR.TaskTime]);
      const task: ScheduleTaskInfo = {
        expressId,
        globalId,
        name: asString(a[TASK_ATTR.Name]) ?? '',
        description: asString(a[TASK_ATTR.Description]),
        objectType: asString(a[TASK_ATTR.ObjectType]),
        identification: asString(a[TASK_ATTR.Identification]),
        longDescription: asString(a[TASK_ATTR.LongDescription]),
        status: asString(a[TASK_ATTR.Status]),
        workMethod: asString(a[TASK_ATTR.WorkMethod]),
        isMilestone: asBoolean(a[TASK_ATTR.IsMilestone]) ?? false,
        priority: asNumber(a[TASK_ATTR.Priority]),
        predefinedType: asEnum(a[TASK_ATTR.PredefinedType]),
        taskTime: taskTimeId !== undefined
          ? extractTaskTime(reader, taskTimeId)
          : undefined,
        childGlobalIds: [],
        productExpressIds: [],
        productGlobalIds: [],
        controllingScheduleGlobalIds: [],
      };
      if (globalId) globalIdByExpressId.set(expressId, globalId);
      taskByExpressId.set(expressId, task);
    }
  }

  // Pass 2: walk IfcRelNests — build task hierarchy.
  for (const relId of relNestsIds) {
    const entity = reader.get(relId);
    if (!entity) continue;
    const a = entity.attributes || [];
    const parent = asRef(a[REL_NESTS_ATTR.RelatingObject]);
    const children = asRefList(a[REL_NESTS_ATTR.RelatedObjects]);
    if (parent === undefined) continue;
    const parentTask = taskByExpressId.get(parent);
    if (!parentTask) continue; // parent isn't a task — task/subtask nesting only; IfcWorkPlan -> IfcWorkSchedule nesting is handled in a separate pass below, once schedules are extracted
    for (const childId of children) {
      const childTask = taskByExpressId.get(childId);
      if (!childTask) continue;
      // A source file may repeat the relation; guard as Pass 4b/5 do below.
      if (!parentTask.childGlobalIds.includes(childTask.globalId)) {
        parentTask.childGlobalIds.push(childTask.globalId);
      }
      if (!childTask.parentGlobalId) {
        childTask.parentGlobalId = parentTask.globalId;
      }
    }
  }

  // Pass 3: resolve IfcRelAssignsToProcess — products assigned to tasks.
  // NOT deduped, deliberately: IfcRelAssignsToProcess carries a
  // QuantityInProcess attribute (not extracted here, but real in the
  // schema), so the same product can legitimately repeat across relations
  // to the same task as separate quantity assignments. Unlike the identity
  // lists elsewhere in this file, this pair is a multiset — dedup would
  // silently drop a legitimate repeated assignment.
  for (const relId of relAssignsProcessIds) {
    const entity = reader.get(relId);
    if (!entity) continue;
    const a = entity.attributes || [];
    const taskId = asRef(a[REL_ASSIGNS_TO_PROCESS_ATTR.RelatingProcess]);
    const products = asRefList(a[REL_ASSIGNS_TO_PROCESS_ATTR.RelatedObjects]);
    if (taskId === undefined) continue;
    const task = taskByExpressId.get(taskId);
    if (!task) continue;
    for (const productId of products) {
      // Resolve the effective product GlobalId and skip tombstoned records.
      const gid = reader.get(productId) ? reader.globalId(productId) : undefined;
      task.productExpressIds.push(productId);
      task.productGlobalIds.push(gid ?? '');
      if (gid) globalIdByExpressId.set(productId, gid);
    }
  }

  // Pass 4: extract work schedules / work plans. The per-entity decode
  // lives in `schedule-control-extractor.ts` alongside the calendar one.
  const workSchedules: WorkScheduleInfo[] = [];
  const scheduleByExpressId = new Map<number, WorkScheduleInfo>();
  const collectSchedules = (ids: readonly number[], kind: 'WorkSchedule' | 'WorkPlan') => {
    for (const id of ids) {
      const info = extractWorkScheduleInfo(reader, id, kind, globalIdByExpressId);
      if (!info) continue;
      workSchedules.push(info);
      scheduleByExpressId.set(id, info);
    }
  };
  collectSchedules(workScheduleIds, 'WorkSchedule');
  collectSchedules(workPlanIds, 'WorkPlan');

  // Pass 4b: walk IfcRelNests again — IfcWorkPlan nesting IfcWorkSchedule.
  // Real-world files use IfcRelNests for this grouping (confirmed against the
  // buildingSMART IFC4 spec's own reference example), distinct from Pass 2's
  // task/subtask hierarchy above, which only resolves parents through
  // taskByExpressId and silently skips a WorkPlan RelatingObject.
  for (const relId of relNestsIds) {
    const entity = reader.get(relId);
    if (!entity) continue;
    const a = entity.attributes || [];
    const parent = asRef(a[REL_NESTS_ATTR.RelatingObject]);
    const children = asRefList(a[REL_NESTS_ATTR.RelatedObjects]);
    if (parent === undefined) continue;
    const parentPlan = scheduleByExpressId.get(parent);
    if (!parentPlan || parentPlan.kind !== 'WorkPlan') continue; // not a work-plan nest
    for (const childId of children) {
      const childSchedule = scheduleByExpressId.get(childId);
      if (!childSchedule || childSchedule.kind !== 'WorkSchedule') continue;
      // This extractor is the sole producer of `parentPlan`: every
      // WorkScheduleInfo it builds above sets `childScheduleGlobalIds: []`,
      // so the field is never actually absent here. `??=` makes that
      // invariant visible to the checker without a non-null assertion, and
      // without treating "absent" any differently from "empty" — both still
      // mean "no nested schedules yet" everywhere else that reads it.
      // Two distinct IfcRelNests entities can nest the same WorkPlan/
      // WorkSchedule pair (a source file may repeat the relation), so guard
      // the push the same way Pass 5 below guards its own append.
      const childGlobalIds = (parentPlan.childScheduleGlobalIds ??= []);
      if (!childGlobalIds.includes(childSchedule.globalId)) {
        childGlobalIds.push(childSchedule.globalId);
      }
      if (!childSchedule.parentPlanGlobalId) {
        childSchedule.parentPlanGlobalId = parentPlan.globalId;
      }
    }
  }

  // Pass 4c: extract IfcWorkCalendar entities. Collection + the
  // calendar-assignment branch of Pass 5 live in
  // `schedule-control-extractor.ts` — split out purely for module size.
  const { workCalendars, calendarByExpressId } = extractWorkCalendars(
    reader,
    schemaIs2x3 ? [] : workCalendarIds,
  );

  // Pass 5: IfcRelAssignsToControl — map schedules to tasks, (a second,
  // distinct grouping path from Pass 4b's IfcRelNests) IfcWorkPlan grouping
  // IfcWorkSchedule, and (via `tryAssignCalendar`) calendar assignment to
  // tasks/schedules. The SDK's scripting bridge (`assignSchedulesToWorkPlan`
  // in packages/create/src/ifc-creator.ts) emits exactly this relation —
  // RelatingControl the plan, RelatedObjects the schedules — not
  // IfcRelNests, so a plan grouped through that bridge must resolve here
  // too or the SDK-authored grouping never reads back.
  // If a source file expresses the same WorkPlan->WorkSchedule pair through
  // *both* relations, Pass 4b (IfcRelNests) runs first and wins:
  // `parentPlanGlobalId` is set-once (guarded below and in Pass 4b), and
  // `childScheduleGlobalIds` is deduped so the pair is not double-counted.
  // `tryAssignCalendar` only ever touches `calendarGlobalIds`, so a task
  // carrying both a controlling schedule and a calendar (via two separate
  // relation instances) gets both fields populated without either clobbering
  // the other.
  for (const relId of relAssignsControlIds) {
    const entity = reader.get(relId);
    if (!entity) continue;
    const a = entity.attributes || [];
    const controlId = asRef(a[REL_ASSIGNS_TO_CONTROL_ATTR.RelatingControl]);
    const objects = asRefList(a[REL_ASSIGNS_TO_CONTROL_ATTR.RelatedObjects]);
    if (controlId === undefined) continue;

    if (tryAssignCalendar(controlId, objects, calendarByExpressId, taskByExpressId, scheduleByExpressId)) {
      continue;
    }

    const schedule = scheduleByExpressId.get(controlId);
    if (!schedule) continue;
    for (const objId of objects) {
      const task = taskByExpressId.get(objId);
      if (task) {
        // A source file may repeat the relation; guard both paired arrays
        // on one predicate to keep them in lockstep. IfcRelAssignsToControl
        // carries no quantity attribute, so this pair is a pure identity
        // edge, unlike Pass 3's productExpressIds/productGlobalIds above.
        if (!schedule.taskGlobalIds.includes(task.globalId)) {
          schedule.taskGlobalIds.push(task.globalId);
          task.controllingScheduleGlobalIds.push(schedule.globalId);
        }
        continue;
      }
      // Not a task — check whether this is a WorkPlan grouping a
      // WorkSchedule via IfcRelAssignsToControl instead of IfcRelNests.
      if (schedule.kind !== 'WorkPlan') continue;
      const childSchedule = scheduleByExpressId.get(objId);
      if (!childSchedule || childSchedule.kind !== 'WorkSchedule') continue;
      const siblings = (schedule.childScheduleGlobalIds ??= []);
      if (!siblings.includes(childSchedule.globalId)) {
        siblings.push(childSchedule.globalId);
      }
      if (!childSchedule.parentPlanGlobalId) {
        childSchedule.parentPlanGlobalId = schedule.globalId;
      }
    }
  }

  // Pass 6: IfcRelSequence — dependency edges between tasks.
  const sequences: ScheduleSequenceInfo[] = [];
  for (const relId of relSeqIds) {
    const entity = reader.get(relId);
    if (!entity) continue;
    const a = entity.attributes || [];
    const relatingId = asRef(a[REL_SEQUENCE_ATTR.RelatingProcess]);
    const relatedId = asRef(a[REL_SEQUENCE_ATTR.RelatedProcess]);
    if (relatingId === undefined || relatedId === undefined) continue;
    const relating = taskByExpressId.get(relatingId);
    const related = taskByExpressId.get(relatedId);
    if (!relating || !related) continue;
    const lagId = asRef(a[REL_SEQUENCE_ATTR.TimeLag]);
    const { seconds: timeLagSeconds, duration: timeLagDuration } =
      lagId !== undefined
        ? extractLagTimeSeconds(reader, lagId)
        : {};
    sequences.push({
      globalId: asString(a[REL_SEQUENCE_ATTR.GlobalId]) ?? '',
      relatingTaskGlobalId: relating.globalId,
      relatedTaskGlobalId: related.globalId,
      sequenceType: sequenceTypeFromString(asEnum(a[REL_SEQUENCE_ATTR.SequenceType])),
      userDefinedSequenceType: asString(a[REL_SEQUENCE_ATTR.UserDefinedSequenceType]),
      timeLagSeconds,
      timeLagDuration,
    });
  }

  return {
    workSchedules,
    tasks: Array.from(taskByExpressId.values()),
    sequences,
    workCalendars,
    hasSchedule: true,
  };
}
