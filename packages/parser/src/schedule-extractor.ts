/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schedule (4D) extractor — walks IfcTask, IfcTaskTime, IfcRelSequence,
 * IfcRelAssignsToProcess, IfcRelAssignsToControl, IfcRelNests, IfcWorkSchedule,
 * IfcWorkPlan, IfcLagTime entities in a parsed IfcDataStore and assembles a
 * normalized ScheduleExtraction that the viewer can drive a Gantt/4D
 * animation from.
 *
 * Handles IFC4 / IFC4X3. IFC2X3 has a different IfcTask layout (no TaskTime
 * attribute, ScheduleStart/ScheduleFinish/TaskOwner instead) and is supported
 * with best-effort degradation.
 *
 * STEP attribute-index layouts, the record types themselves, and the small
 * pure/single-entity helpers (`asString` et al., `extractTaskTime`,
 * `extractLagTimeSeconds`) live in `schedule-types.ts` — this file owns only
 * the cross-entity orchestration (the multi-pass walk below that wires those
 * records together via their IFC relationships).
 */

import { EntityExtractor } from './entity-extractor.js';
import type { IfcDataStore } from './columnar-parser.js';
import { parseIso8601Duration } from './iso8601-duration.js';
import {
  TASK_ATTR,
  TASK_ATTR_2X3,
  REL_SEQUENCE_ATTR,
  REL_ASSIGNS_TO_PROCESS_ATTR,
  REL_ASSIGNS_TO_CONTROL_ATTR,
  REL_NESTS_ATTR,
  WORK_SCHEDULE_ATTR,
  WORK_PLAN_ATTR,
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

/**
 * Extract all scheduling data from a parsed IFC store.
 *
 * Walks every IfcTask / IfcTaskTime / IfcRelSequence / IfcRelAssignsToProcess /
 * IfcRelAssignsToControl / IfcRelNests / IfcWorkSchedule / IfcWorkPlan entity
 * and assembles a connected ScheduleExtraction.
 */
export function extractScheduleOnDemand(store: IfcDataStore): ScheduleExtraction {
  if (!store.source?.length) {
    return { workSchedules: [], tasks: [], sequences: [], hasSchedule: false };
  }

  const byType = store.entityIndex.byType;
  const taskIds = byType.get('IFCTASK') ?? [];
  const workScheduleIds = byType.get('IFCWORKSCHEDULE') ?? [];
  const workPlanIds = byType.get('IFCWORKPLAN') ?? [];
  const relSeqIds = byType.get('IFCRELSEQUENCE') ?? [];
  const relAssignsProcessIds = byType.get('IFCRELASSIGNSTOPROCESS') ?? [];
  const relAssignsControlIds = byType.get('IFCRELASSIGNSTOCONTROL') ?? [];
  const relNestsIds = byType.get('IFCRELNESTS') ?? [];

  const hasAny =
    taskIds.length +
      workScheduleIds.length +
      workPlanIds.length +
      relSeqIds.length >
    0;

  if (!hasAny) {
    return { workSchedules: [], tasks: [], sequences: [], hasSchedule: false };
  }

  const extractor = new EntityExtractor(store.source);
  const schemaIs2x3 = store.schemaVersion === 'IFC2X3';

  /** expressId -> task record (for cross-linking) */
  const taskByExpressId = new Map<number, ScheduleTaskInfo>();
  /** expressId -> globalId (for products & schedules & tasks) */
  const globalIdByExpressId = new Map<number, string>();

  // Pass 1: extract base IfcTask records.
  for (const expressId of taskIds) {
    const ref = store.entityIndex.byId.get(expressId);
    if (!ref) continue;
    const entity = extractor.extractEntity(ref);
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
          ? extractTaskTime(extractor, store, taskTimeId)
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
    const ref = store.entityIndex.byId.get(relId);
    if (!ref) continue;
    const entity = extractor.extractEntity(ref);
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
    const ref = store.entityIndex.byId.get(relId);
    if (!ref) continue;
    const entity = extractor.extractEntity(ref);
    if (!entity) continue;
    const a = entity.attributes || [];
    const taskId = asRef(a[REL_ASSIGNS_TO_PROCESS_ATTR.RelatingProcess]);
    const products = asRefList(a[REL_ASSIGNS_TO_PROCESS_ATTR.RelatedObjects]);
    if (taskId === undefined) continue;
    const task = taskByExpressId.get(taskId);
    if (!task) continue;
    for (const productId of products) {
      // resolve product globalId lazily from the entity table if available
      const gid = store.entities?.getGlobalId?.(productId) ?? undefined;
      task.productExpressIds.push(productId);
      task.productGlobalIds.push(gid ?? '');
      if (gid) globalIdByExpressId.set(productId, gid);
    }
  }

  // Pass 4: extract work schedules / work plans.
  const workSchedules: WorkScheduleInfo[] = [];
  const scheduleByExpressId = new Map<number, WorkScheduleInfo>();

  const extractSchedule = (
    expressId: number,
    kind: 'WorkSchedule' | 'WorkPlan',
  ): WorkScheduleInfo | null => {
    const ref = store.entityIndex.byId.get(expressId);
    if (!ref) return null;
    const entity = extractor.extractEntity(ref);
    if (!entity) return null;
    const a = entity.attributes || [];
    const layout = kind === 'WorkPlan' ? WORK_PLAN_ATTR : WORK_SCHEDULE_ATTR;
    const globalId = asString(a[layout.GlobalId]) ?? '';
    const info: WorkScheduleInfo = {
      expressId,
      kind,
      globalId,
      name: asString(a[layout.Name]) ?? kind,
      description: asString(a[layout.Description]),
      identification: asString(a[layout.Identification]),
      creationDate: asString(a[layout.CreationDate]),
      purpose: asString(a[layout.Purpose]),
      duration: asString(a[layout.Duration]),
      startTime: asString(a[layout.StartTime]),
      finishTime: asString(a[layout.FinishTime]),
      predefinedType: asEnum(a[layout.PredefinedType]),
      taskGlobalIds: [],
      childScheduleGlobalIds: [],
    };
    if (globalId) globalIdByExpressId.set(expressId, globalId);
    return info;
  };

  for (const id of workScheduleIds) {
    const info = extractSchedule(id, 'WorkSchedule');
    if (info) {
      workSchedules.push(info);
      scheduleByExpressId.set(id, info);
    }
  }
  for (const id of workPlanIds) {
    const info = extractSchedule(id, 'WorkPlan');
    if (info) {
      workSchedules.push(info);
      scheduleByExpressId.set(id, info);
    }
  }

  // Pass 4b: walk IfcRelNests again — IfcWorkPlan nesting IfcWorkSchedule.
  // Real-world files use IfcRelNests for this grouping (confirmed against the
  // buildingSMART IFC4 spec's own reference example), distinct from Pass 2's
  // task/subtask hierarchy above, which only resolves parents through
  // taskByExpressId and silently skips a WorkPlan RelatingObject.
  for (const relId of relNestsIds) {
    const ref = store.entityIndex.byId.get(relId);
    if (!ref) continue;
    const entity = extractor.extractEntity(ref);
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

  // Pass 5: IfcRelAssignsToControl — map schedules to tasks, and (a second,
  // distinct grouping path from Pass 4b's IfcRelNests) IfcWorkPlan grouping
  // IfcWorkSchedule. The SDK's scripting bridge
  // (`assignSchedulesToWorkPlan` in packages/create/src/ifc-creator.ts)
  // emits exactly this relation — RelatingControl the plan, RelatedObjects
  // the schedules — not IfcRelNests, so a plan grouped through that bridge
  // must resolve here too or the SDK-authored grouping never reads back.
  // If a source file expresses the same WorkPlan->WorkSchedule pair through
  // *both* relations, Pass 4b (IfcRelNests) runs first and wins:
  // `parentPlanGlobalId` is set-once (guarded below and in Pass 4b), and
  // `childScheduleGlobalIds` is deduped so the pair is not double-counted.
  for (const relId of relAssignsControlIds) {
    const ref = store.entityIndex.byId.get(relId);
    if (!ref) continue;
    const entity = extractor.extractEntity(ref);
    if (!entity) continue;
    const a = entity.attributes || [];
    const controlId = asRef(a[REL_ASSIGNS_TO_CONTROL_ATTR.RelatingControl]);
    const objects = asRefList(a[REL_ASSIGNS_TO_CONTROL_ATTR.RelatedObjects]);
    if (controlId === undefined) continue;
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
    const ref = store.entityIndex.byId.get(relId);
    if (!ref) continue;
    const entity = extractor.extractEntity(ref);
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
        ? extractLagTimeSeconds(extractor, store, lagId)
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
    hasSchedule: true,
  };
}
