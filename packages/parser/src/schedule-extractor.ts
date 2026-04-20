/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schedule (4D) extractor — parses IfcTask, IfcTaskTime, IfcRelSequence,
 * IfcRelAssignsToProcess, IfcRelAssignsToControl, IfcRelNests, IfcWorkSchedule,
 * IfcWorkPlan, IfcLagTime from a parsed IfcDataStore and returns a normalized
 * ScheduleExtraction that the viewer can drive a Gantt/4D animation from.
 *
 * Handles IFC4 / IFC4X3. IFC2X3 has a different IfcTask layout (no TaskTime
 * attribute, ScheduleStart/ScheduleFinish/TaskOwner instead) and is supported
 * with best-effort degradation.
 */

import { EntityExtractor } from './entity-extractor.js';
import type { IfcDataStore } from './columnar-parser.js';

/** IFC4 STEP attribute indices for IfcTask. */
const TASK_ATTR = {
  GlobalId: 0,
  Name: 2,
  Description: 3,
  ObjectType: 4,
  Identification: 5,
  LongDescription: 6,
  Status: 7,
  WorkMethod: 8,
  IsMilestone: 9,
  Priority: 10,
  TaskTime: 11,
  PredefinedType: 12,
} as const;

/**
 * IFC2X3 IfcTask layout — the attributes IfcTask itself adds over IfcObject
 * (TaskId, Status, WorkMethod, IsMilestone, Priority). IFC2X3 schedule times
 * live on `IfcScheduleTimeControl` and link to IfcTask via `IfcRelAssignsTasks`
 * — we don't resolve those here yet; best-effort 2x3 models only surface task
 * metadata without dates.
 */
const TASK_ATTR_2X3 = {
  GlobalId: 0,
  Name: 2,
  Description: 3,
  ObjectType: 4,
  TaskId: 5,
  Status: 6,
  WorkMethod: 7,
  IsMilestone: 8,
  Priority: 9,
} as const;

const TASK_TIME_ATTR = {
  Name: 0,
  DurationType: 3,
  ScheduleDuration: 4,
  ScheduleStart: 5,
  ScheduleFinish: 6,
  EarlyStart: 7,
  EarlyFinish: 8,
  LateStart: 9,
  LateFinish: 10,
  FreeFloat: 11,
  TotalFloat: 12,
  IsCritical: 13,
  StatusTime: 14,
  ActualDuration: 15,
  ActualStart: 16,
  ActualFinish: 17,
  RemainingTime: 18,
  Completion: 19,
} as const;

const REL_SEQUENCE_ATTR = {
  GlobalId: 0,
  RelatingProcess: 4,
  RelatedProcess: 5,
  TimeLag: 6,
  SequenceType: 7,
  UserDefinedSequenceType: 8,
} as const;

const REL_ASSIGNS_TO_PROCESS_ATTR = {
  RelatedObjects: 4,
  RelatingProcess: 6,
} as const;

const REL_ASSIGNS_TO_CONTROL_ATTR = {
  RelatedObjects: 4,
  RelatingControl: 6,
} as const;

const REL_NESTS_ATTR = {
  RelatingObject: 4,
  RelatedObjects: 5,
} as const;

const WORK_SCHEDULE_ATTR = {
  GlobalId: 0,
  Name: 2,
  Description: 3,
  ObjectType: 4,
  Identification: 5,
  CreationDate: 6,
  Purpose: 8,
  Duration: 9,
  TotalFloat: 10,
  StartTime: 11,
  FinishTime: 12,
  PredefinedType: 13,
} as const;

const WORK_PLAN_ATTR = WORK_SCHEDULE_ATTR;

const LAG_TIME_ATTR = {
  LagValue: 3,
  DurationType: 4,
} as const;

export type SequenceTypeEnum =
  | 'START_START'
  | 'START_FINISH'
  | 'FINISH_START'
  | 'FINISH_FINISH'
  | 'USERDEFINED'
  | 'NOTDEFINED';

export type TaskDurationType = 'WORKTIME' | 'ELAPSEDTIME' | 'NOTDEFINED';

export interface ScheduleTaskTimeInfo {
  scheduleStart?: string;
  scheduleFinish?: string;
  scheduleDuration?: string;
  actualStart?: string;
  actualFinish?: string;
  actualDuration?: string;
  earlyStart?: string;
  earlyFinish?: string;
  lateStart?: string;
  lateFinish?: string;
  freeFloat?: string;
  totalFloat?: string;
  remainingTime?: string;
  durationType?: TaskDurationType;
  statusTime?: string;
  isCritical?: boolean;
  completion?: number;
}

export interface ScheduleTaskInfo {
  expressId: number;
  globalId: string;
  name: string;
  description?: string;
  objectType?: string;
  identification?: string;
  longDescription?: string;
  status?: string;
  workMethod?: string;
  isMilestone: boolean;
  priority?: number;
  predefinedType?: string;
  taskTime?: ScheduleTaskTimeInfo;
  /** Parent task globalId (from IfcRelNests where this task is in RelatedObjects). */
  parentGlobalId?: string;
  /** Child task globalIds (from IfcRelNests where this task is RelatingObject). */
  childGlobalIds: string[];
  /** expressIds of products assigned to this task via IfcRelAssignsToProcess. */
  productExpressIds: number[];
  /** globalIds of the same products (aligned with productExpressIds by index). */
  productGlobalIds: string[];
  /** WorkSchedule globalIds that control this task via IfcRelAssignsToControl. */
  controllingScheduleGlobalIds: string[];
}

export interface ScheduleSequenceInfo {
  globalId: string;
  relatingTaskGlobalId: string;
  relatedTaskGlobalId: string;
  sequenceType: SequenceTypeEnum;
  userDefinedSequenceType?: string;
  /** Lag value expressed in seconds if it resolves to an IfcDuration; otherwise undefined. */
  timeLagSeconds?: number;
  /** Original lag duration string (ISO 8601 like 'P1D'), if available. */
  timeLagDuration?: string;
}

export interface WorkScheduleInfo {
  expressId: number;
  globalId: string;
  kind: 'WorkSchedule' | 'WorkPlan';
  name: string;
  description?: string;
  identification?: string;
  creationDate?: string;
  purpose?: string;
  duration?: string;
  startTime?: string;
  finishTime?: string;
  predefinedType?: string;
  /** Root task globalIds directly assigned via IfcRelAssignsToControl. */
  taskGlobalIds: string[];
}

export interface ScheduleExtraction {
  workSchedules: WorkScheduleInfo[];
  tasks: ScheduleTaskInfo[];
  sequences: ScheduleSequenceInfo[];
  /** True if we encountered any scheduling entity (useful for empty-state UI). */
  hasSchedule: boolean;
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  // STEP booleans are typically stored as '.T.' / '.F.' after parsing
  if (typeof v === 'string') {
    if (v === '.T.' || v === 'T') return true;
    if (v === '.F.' || v === 'F') return false;
  }
  return undefined;
}

function asEnum(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined;
  // STEP enum looks like .PLANNED.
  const match = v.match(/^\.([A-Z_]+)\.$/);
  return match ? match[1] : undefined;
}

function asRef(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  return undefined;
}

function asRefList(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) {
    const id = asRef(x);
    if (id !== undefined) out.push(id);
  }
  return out;
}

function sequenceTypeFromString(s: string | undefined): SequenceTypeEnum {
  switch (s) {
    case 'START_START':
    case 'START_FINISH':
    case 'FINISH_START':
    case 'FINISH_FINISH':
    case 'USERDEFINED':
    case 'NOTDEFINED':
      return s;
    default:
      return 'FINISH_START';
  }
}

function durationTypeFromString(s: string | undefined): TaskDurationType | undefined {
  switch (s) {
    case 'WORKTIME':
    case 'ELAPSEDTIME':
    case 'NOTDEFINED':
      return s;
    default:
      return undefined;
  }
}

/**
 * Parse an ISO-8601 duration string (e.g. "P1D", "PT2H30M", "P1Y2M3DT4H5M6S")
 * into a number of seconds. Returns undefined on invalid input.
 */
export function parseIso8601Duration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(
    /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  if (!match) return undefined;
  const [, y, mo, w, d, h, mi, s] = match;
  // Reject bare "P" / "PT" which would otherwise silently return 0 and mask
  // malformed IfcLagTime / IfcTaskTime durations.
  if (y === undefined && mo === undefined && w === undefined && d === undefined
    && h === undefined && mi === undefined && s === undefined) {
    return undefined;
  }
  const yearSec = 365.2425 * 86400;
  const monthSec = yearSec / 12;
  return (
    (y ? parseFloat(y) * yearSec : 0) +
    (mo ? parseFloat(mo) * monthSec : 0) +
    (w ? parseFloat(w) * 7 * 86400 : 0) +
    (d ? parseFloat(d) * 86400 : 0) +
    (h ? parseFloat(h) * 3600 : 0) +
    (mi ? parseFloat(mi) * 60 : 0) +
    (s ? parseFloat(s) : 0)
  );
}

function extractTaskTime(
  extractor: EntityExtractor,
  store: IfcDataStore,
  taskTimeId: number,
): ScheduleTaskTimeInfo | undefined {
  const ref = store.entityIndex.byId.get(taskTimeId);
  if (!ref) return undefined;
  const entity = extractor.extractEntity(ref);
  if (!entity) return undefined;
  const t = entity.type.toUpperCase();
  if (t !== 'IFCTASKTIME' && t !== 'IFCTASKTIMERECURRING') return undefined;
  const a = entity.attributes || [];
  return {
    durationType: durationTypeFromString(asEnum(a[TASK_TIME_ATTR.DurationType])),
    scheduleDuration: asString(a[TASK_TIME_ATTR.ScheduleDuration]),
    scheduleStart: asString(a[TASK_TIME_ATTR.ScheduleStart]),
    scheduleFinish: asString(a[TASK_TIME_ATTR.ScheduleFinish]),
    earlyStart: asString(a[TASK_TIME_ATTR.EarlyStart]),
    earlyFinish: asString(a[TASK_TIME_ATTR.EarlyFinish]),
    lateStart: asString(a[TASK_TIME_ATTR.LateStart]),
    lateFinish: asString(a[TASK_TIME_ATTR.LateFinish]),
    freeFloat: asString(a[TASK_TIME_ATTR.FreeFloat]),
    totalFloat: asString(a[TASK_TIME_ATTR.TotalFloat]),
    isCritical: asBoolean(a[TASK_TIME_ATTR.IsCritical]),
    statusTime: asString(a[TASK_TIME_ATTR.StatusTime]),
    actualDuration: asString(a[TASK_TIME_ATTR.ActualDuration]),
    actualStart: asString(a[TASK_TIME_ATTR.ActualStart]),
    actualFinish: asString(a[TASK_TIME_ATTR.ActualFinish]),
    remainingTime: asString(a[TASK_TIME_ATTR.RemainingTime]),
    completion: asNumber(a[TASK_TIME_ATTR.Completion]),
  };
}

function extractLagTimeSeconds(
  extractor: EntityExtractor,
  store: IfcDataStore,
  lagId: number,
): { seconds?: number; duration?: string } {
  const ref = store.entityIndex.byId.get(lagId);
  if (!ref) return {};
  const entity = extractor.extractEntity(ref);
  if (!entity) return {};
  if (entity.type.toUpperCase() !== 'IFCLAGTIME') return {};
  const a = entity.attributes || [];
  const lagValue = a[LAG_TIME_ATTR.LagValue];
  // lagValue is an IfcTimeOrRatioSelect — either a typed wrapper like
  // ['IFCDURATION', 'P1D'] or a direct ratio number.
  if (Array.isArray(lagValue) && lagValue.length === 2) {
    const typeName = String(lagValue[0]).toUpperCase();
    const inner = lagValue[1];
    if (typeName === 'IFCDURATION' && typeof inner === 'string') {
      return { seconds: parseIso8601Duration(inner), duration: inner };
    }
  } else if (typeof lagValue === 'string') {
    return { seconds: parseIso8601Duration(lagValue), duration: lagValue };
  }
  return {};
}

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
    if (!parentTask) continue; // nesting over non-task entities — ignore
    for (const childId of children) {
      const childTask = taskByExpressId.get(childId);
      if (!childTask) continue;
      parentTask.childGlobalIds.push(childTask.globalId);
      if (!childTask.parentGlobalId) {
        childTask.parentGlobalId = parentTask.globalId;
      }
    }
  }

  // Pass 3: resolve IfcRelAssignsToProcess — products assigned to tasks.
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

  // Pass 5: IfcRelAssignsToControl — map schedules to tasks.
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
      if (!task) continue;
      schedule.taskGlobalIds.push(task.globalId);
      task.controllingScheduleGlobalIds.push(schedule.globalId);
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
