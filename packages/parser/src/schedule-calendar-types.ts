/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IfcWorkCalendar / IfcWorkTime / IfcRecurrencePattern / IfcTimePeriod
 * shapes and single-entity sub-extractors — the calendar-side sibling of
 * `schedule-types.ts`, split into its own file purely to keep both files
 * under the ~400-line module-size guideline (see AGENTS.md). Same
 * "attribute-index decoding, not cross-entity wiring" concern as
 * `schedule-types.ts`: `schedule-extractor.ts` calls `extractWorkCalendar`
 * once per `IFCWORKCALENDAR` express id and wires the result into
 * `ScheduleTaskInfo.calendarGlobalIds` / `WorkScheduleInfo.calendarGlobalIds`
 * via the generic `IfcRelAssignsToControl` walk it already runs.
 *
 * IFC2X3 is explicitly out of scope: IfcWorkCalendar in that schema has a
 * different, older attribute layout (no `WorkingTimes`/`ExceptionTimes`
 * lists in the same shape), matching this package's existing
 * `TASK_ATTR_2X3` precedent of best-effort degrading rather than
 * re-deriving a second layout. `extractWorkCalendar` below is IFC4/IFC4X3
 * only; a 2X3 file's IFCWORKCALENDAR entities are silently skipped by
 * `schedule-extractor.ts`'s `byType.get('IFCWORKCALENDAR')` walk.
 */

import type { CostEntityReader } from './cost-reader.js';
import { asString, asNumber, asEnum, asRef, asRefList } from './schedule-types.js';
import { deterministicGlobalId } from './deterministic-global-id.js';

/**
 * IFC4/IFC4X3 STEP attribute indices for IfcWorkCalendar. Like
 * IfcWorkSchedule/IfcWorkPlan it extends IfcControl < IfcObject <
 * IfcObjectDefinition < IfcRoot, so it shares the same GlobalId..
 * Identification slots (0,2..5) as `WORK_SCHEDULE_ATTR` in
 * schedule-types.ts — but its supertype is IfcControl directly (not
 * IfcWorkControl), so the trailing fields diverge from index 6 onward
 * (WorkingTimes/ExceptionTimes/PredefinedType instead of CreationDate/.../
 * FinishTime). Kept as its own const rather than sharing
 * WORK_SCHEDULE_ATTR's shape past index 5, since reusing it would either
 * need the WorkSchedule-only fields present-but-unused or a confusing
 * partial overlap.
 */
export const WORK_CALENDAR_ATTR = {
  GlobalId: 0,
  Name: 2,
  Description: 3,
  ObjectType: 4,
  Identification: 5,
  WorkingTimes: 6,
  ExceptionTimes: 7,
  PredefinedType: 8,
} as const;

/** IfcWorkTime extends IfcSchedulingTime — NOT IfcRoot, so no GlobalId. */
const WORK_TIME_ATTR = {
  Name: 0,
  DataOrigin: 1,
  UserDefinedDataOrigin: 2,
  RecurrencePattern: 3,
  Start: 4,
  Finish: 5,
} as const;

/** IfcRecurrencePattern — standalone entity, no supertype. */
const RECURRENCE_PATTERN_ATTR = {
  RecurrenceType: 0,
  DayComponent: 1,
  WeekdayComponent: 2,
  MonthComponent: 3,
  Position: 4,
  Interval: 5,
  Occurrences: 6,
  TimePeriods: 7,
} as const;

/** IfcTimePeriod — standalone entity, StartTime/EndTime only. */
const TIME_PERIOD_ATTR = {
  StartTime: 0,
  EndTime: 1,
} as const;

/** A single StartTime/EndTime pair from an IfcRecurrencePattern's TimePeriods. */
export interface TimePeriodInfo {
  start: string;
  end: string;
}

export interface RecurrencePatternInfo {
  recurrenceType?: string;
  dayComponent: number[];
  weekdayComponent: number[];
  monthComponent: number[];
  position?: number;
  interval?: number;
  occurrences?: number;
  /** See `extractRecurrencePattern` below for why this is a plain array of resolved pairs rather than express-id refs. */
  timePeriods: TimePeriodInfo[];
}

export interface WorkTimeInfo {
  name?: string;
  dataOrigin?: string;
  userDefinedDataOrigin?: string;
  recurrencePattern?: RecurrencePatternInfo;
  /** IfcDate string, e.g. "2024-05-01". */
  start?: string;
  finish?: string;
}

export interface WorkCalendarInfo {
  expressId: number;
  globalId: string;
  name: string;
  description?: string;
  objectType?: string;
  identification?: string;
  predefinedType?: string;
  workingTimes: WorkTimeInfo[];
  exceptionTimes: WorkTimeInfo[];
}

function extractTimePeriod(
  reader: CostEntityReader,
  timePeriodId: number,
): TimePeriodInfo | undefined {
  const entity = reader.get(timePeriodId);
  if (!entity) return undefined;
  if (entity.type.toUpperCase() !== 'IFCTIMEPERIOD') return undefined;
  const a = entity.attributes || [];
  const start = asString(a[TIME_PERIOD_ATTR.StartTime]);
  const end = asString(a[TIME_PERIOD_ATTR.EndTime]);
  if (start === undefined || end === undefined) return undefined;
  return { start, end };
}

function extractRecurrencePattern(
  reader: CostEntityReader,
  patternId: number,
): RecurrencePatternInfo | undefined {
  const entity = reader.get(patternId);
  if (!entity) return undefined;
  if (entity.type.toUpperCase() !== 'IFCRECURRENCEPATTERN') return undefined;
  const a = entity.attributes || [];
  // TimePeriods is a LIST of IfcTimePeriod entity refs (IfcTimePeriod is a
  // standalone two-attribute entity, not an inline aggregate), so resolving
  // it is the same one-level "list of refs -> resolve each" shape as
  // WorkingTimes/ExceptionTimes below — straightforward enough to extract in
  // full rather than falling back to the opaque-list option the task spec
  // allowed for.
  const timePeriodIds = asRefList(a[RECURRENCE_PATTERN_ATTR.TimePeriods]);
  const timePeriods: TimePeriodInfo[] = [];
  for (const id of timePeriodIds) {
    const tp = extractTimePeriod(reader, id);
    if (tp) timePeriods.push(tp);
  }
  return {
    recurrenceType: asEnum(a[RECURRENCE_PATTERN_ATTR.RecurrenceType]),
    dayComponent: asNumberList(a[RECURRENCE_PATTERN_ATTR.DayComponent]),
    weekdayComponent: asNumberList(a[RECURRENCE_PATTERN_ATTR.WeekdayComponent]),
    monthComponent: asNumberList(a[RECURRENCE_PATTERN_ATTR.MonthComponent]),
    position: asNumber(a[RECURRENCE_PATTERN_ATTR.Position]),
    interval: asNumber(a[RECURRENCE_PATTERN_ATTR.Interval]),
    occurrences: asNumber(a[RECURRENCE_PATTERN_ATTR.Occurrences]),
    timePeriods,
  };
}

function asNumberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(asNumber).filter((n): n is number => n !== undefined);
}

function extractWorkTime(
  reader: CostEntityReader,
  workTimeId: number,
): WorkTimeInfo | undefined {
  const entity = reader.get(workTimeId);
  if (!entity) return undefined;
  if (entity.type.toUpperCase() !== 'IFCWORKTIME') return undefined;
  const a = entity.attributes || [];
  const recurrenceId = asRef(a[WORK_TIME_ATTR.RecurrencePattern]);
  return {
    name: asString(a[WORK_TIME_ATTR.Name]),
    dataOrigin: asEnum(a[WORK_TIME_ATTR.DataOrigin]),
    userDefinedDataOrigin: asString(a[WORK_TIME_ATTR.UserDefinedDataOrigin]),
    recurrencePattern: recurrenceId !== undefined
      ? extractRecurrencePattern(reader, recurrenceId)
      : undefined,
    start: asString(a[WORK_TIME_ATTR.Start]),
    finish: asString(a[WORK_TIME_ATTR.Finish]),
  };
}

/**
 * Extract one IfcWorkCalendar, resolving its WorkingTimes/ExceptionTimes
 * (each an IfcWorkTime, optionally carrying an IfcRecurrencePattern).
 * Shaped like `extractTaskTime` in schedule-types.ts — single entity in,
 * typed record out, `undefined` when the express id doesn't resolve to an
 * IFCWORKCALENDAR.
 */
export function extractWorkCalendar(
  reader: CostEntityReader,
  calendarId: number,
): WorkCalendarInfo | undefined {
  const entity = reader.get(calendarId);
  if (!entity) return undefined;
  if (entity.type.toUpperCase() !== 'IFCWORKCALENDAR') return undefined;
  const a = entity.attributes || [];
  const workingTimeIds = asRefList(a[WORK_CALENDAR_ATTR.WorkingTimes]);
  const exceptionTimeIds = asRefList(a[WORK_CALENDAR_ATTR.ExceptionTimes]);
  const workingTimes: WorkTimeInfo[] = [];
  for (const id of workingTimeIds) {
    const wt = extractWorkTime(reader, id);
    if (wt) workingTimes.push(wt);
  }
  const exceptionTimes: WorkTimeInfo[] = [];
  for (const id of exceptionTimeIds) {
    const wt = extractWorkTime(reader, id);
    if (wt) exceptionTimes.push(wt);
  }
  return {
    expressId: calendarId,
    globalId: asString(a[WORK_CALENDAR_ATTR.GlobalId])
      ?? deterministicGlobalId(`extracted-work-calendar|${calendarId}`),
    name: asString(a[WORK_CALENDAR_ATTR.Name]) ?? '',
    description: asString(a[WORK_CALENDAR_ATTR.Description]),
    objectType: asString(a[WORK_CALENDAR_ATTR.ObjectType]),
    identification: asString(a[WORK_CALENDAR_ATTR.Identification]),
    predefinedType: asEnum(a[WORK_CALENDAR_ATTR.PredefinedType]),
    workingTimes,
    exceptionTimes,
  };
}
