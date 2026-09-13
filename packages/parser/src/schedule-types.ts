/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schedule (4D) shapes and sub-entity extractors — STEP attribute-index
 * layouts for IfcTask / IfcTaskTime / IfcRelSequence / IfcRelAssignsToProcess
 * / IfcRelAssignsToControl / IfcRelNests / IfcWorkSchedule / IfcWorkPlan /
 * IfcLagTime, the public `ScheduleExtraction` record types built from them,
 * and the small pure helpers (`asString` et al.) plus single-entity
 * sub-extractors (`extractTaskTime`, `extractLagTimeSeconds`) that turn one
 * STEP entity's attribute array into a typed field.
 *
 * `schedule-extractor.ts` owns the orchestration — walking `byType` arrays
 * and wiring these records together across passes — and imports everything
 * it needs from here. Splitting "how one entity's attributes decode" from
 * "how entities cross-reference each other" keeps each file to one concern,
 * the same shape as this package's `spatial-hierarchy-canonical-parent.ts`
 * being split out of `spatial-hierarchy-builder.ts`.
 */

import { EntityExtractor } from './entity-extractor.js';
import type { IfcDataStore } from './columnar-parser.js';
import { parseIso8601Duration } from './iso8601-duration.js';

/** IFC4 STEP attribute indices for IfcTask. */
export const TASK_ATTR = {
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
export const TASK_ATTR_2X3 = {
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

export const REL_SEQUENCE_ATTR = {
  GlobalId: 0,
  RelatingProcess: 4,
  RelatedProcess: 5,
  TimeLag: 6,
  SequenceType: 7,
  UserDefinedSequenceType: 8,
} as const;

export const REL_ASSIGNS_TO_PROCESS_ATTR = {
  RelatedObjects: 4,
  RelatingProcess: 6,
} as const;

export const REL_ASSIGNS_TO_CONTROL_ATTR = {
  RelatedObjects: 4,
  RelatingControl: 6,
} as const;

export const REL_NESTS_ATTR = {
  RelatingObject: 4,
  RelatedObjects: 5,
} as const;

export const WORK_SCHEDULE_ATTR = {
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

export const WORK_PLAN_ATTR = WORK_SCHEDULE_ATTR;

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
  /**
   * Parent IfcWorkPlan globalId, when this schedule is nested under a work
   * plan via IfcRelNests (this schedule as a RelatedObject). Undefined for
   * a WorkPlan itself, or a WorkSchedule with no nesting parent.
   */
  parentPlanGlobalId?: string;
  /**
   * Child IfcWorkSchedule globalIds nested under this work plan via
   * IfcRelNests or IfcRelAssignsToControl (this record as the parent side).
   * Empty (or absent) for a plain WorkSchedule, or a WorkPlan with no
   * nested schedules.
   *
   * Optional so a `WorkScheduleInfo` built without any opinion on grouping
   * doesn't have to populate a field it never touches. Absent and `[]` are
   * equivalent everywhere this field is read — neither the extractor nor
   * the serializer distinguishes "unknown/legacy" from "known and empty";
   * both mean "no nested schedules to write or report".
   */
  childScheduleGlobalIds?: string[];
}

export interface ScheduleExtraction {
  workSchedules: WorkScheduleInfo[];
  tasks: ScheduleTaskInfo[];
  sequences: ScheduleSequenceInfo[];
  /** True if we encountered any scheduling entity (useful for empty-state UI). */
  hasSchedule: boolean;
}

export function asString(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}

export function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

export function asBoolean(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  // STEP booleans are typically stored as '.T.' / '.F.' after parsing
  if (typeof v === 'string') {
    if (v === '.T.' || v === 'T') return true;
    if (v === '.F.' || v === 'F') return false;
  }
  return undefined;
}

export function asEnum(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined;
  // STEP enum looks like .PLANNED.
  const match = v.match(/^\.([A-Z_]+)\.$/);
  return match ? match[1] : undefined;
}

export function asRef(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  return undefined;
}

export function asRefList(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) {
    const id = asRef(x);
    if (id !== undefined) out.push(id);
  }
  return out;
}

export function sequenceTypeFromString(s: string | undefined): SequenceTypeEnum {
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

export function extractTaskTime(
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

export function extractLagTimeSeconds(
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
