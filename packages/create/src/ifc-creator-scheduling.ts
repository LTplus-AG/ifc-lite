/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * STEP emission for the 4D scheduling entities that carry no attributes of
 * their own on `IfcCreator` — IfcTaskTime, and IfcWorkCalendar with the
 * entities its WorkingTimes / ExceptionTimes lists reference (IfcWorkTime,
 * IfcRecurrencePattern, IfcTimePeriod).
 *
 * Split out of `ifc-creator.ts` so that file doesn't grow past its recorded
 * module-size budget (see `scripts/module-size-allowlist.txt`). The
 * dependency on the creator is narrowed to one `EmitEntity` callback — it
 * allocates the next express id, writes the `#N=TYPE(attrs);` line, and
 * returns the id — so nothing here needs the creator's private state.
 */

import type { WorkCalendarParams, WorkTimeParams, RecurrencePatternParams, TaskParams, WorkScheduleParams } from './types.js';
import { esc, optStr, optEnum, optBool, optReal, optInt, refList, intList } from './ifc-creator-math.js';

/** Allocate an express id, emit `#id=TYPE(attrs);`, and return the id. */
export type EmitEntity = (type: string, attrs: string) => number;

function assertInteger(value: number, attribute: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`IfcRecurrencePattern.${attribute} values must be finite integers`);
  }
}

function validateComponent(values: number[] | undefined, attribute: string, min: number, max: number): void {
  for (const value of values ?? []) {
    assertInteger(value, attribute);
    if (value < min || value > max) {
      throw new Error(`IfcRecurrencePattern.${attribute} values must be between ${min} and ${max}`);
    }
  }
}

function validateRecurrencePattern(params: RecurrencePatternParams): void {
  validateComponent(params.DayComponent, 'DayComponent', 1, 31);
  validateComponent(params.WeekdayComponent, 'WeekdayComponent', 1, 7);
  validateComponent(params.MonthComponent, 'MonthComponent', 1, 12);
  if (params.Position !== undefined) assertInteger(params.Position, 'Position');
  if (params.Interval !== undefined) {
    assertInteger(params.Interval, 'Interval');
    if (params.Interval <= 0) {
      throw new Error('IfcRecurrencePattern.Interval must be a positive integer');
    }
  }
  if (params.Occurrences !== undefined) assertInteger(params.Occurrences, 'Occurrences');

  const allowedByType: Record<RecurrencePatternParams['RecurrenceType'], ReadonlySet<string>> = {
    DAILY: new Set(),
    WEEKLY: new Set(['WeekdayComponent']),
    MONTHLY_BY_DAY_OF_MONTH: new Set(['DayComponent']),
    MONTHLY_BY_POSITION: new Set(['WeekdayComponent', 'Position']),
    BY_DAY_COUNT: new Set(),
    BY_WEEKDAY_COUNT: new Set(['WeekdayComponent']),
    YEARLY_BY_DAY_OF_MONTH: new Set(['DayComponent', 'MonthComponent']),
    YEARLY_BY_POSITION: new Set(['WeekdayComponent', 'MonthComponent', 'Position']),
  };
  const supplied = [
    ['DayComponent', (params.DayComponent?.length ?? 0) > 0],
    ['WeekdayComponent', (params.WeekdayComponent?.length ?? 0) > 0],
    ['MonthComponent', (params.MonthComponent?.length ?? 0) > 0],
    ['Position', params.Position !== undefined],
  ] as const;
  const allowed = allowedByType[params.RecurrenceType];
  for (const [attribute, isSupplied] of supplied) {
    if (isSupplied && !allowed.has(attribute)) {
      throw new Error(`IfcRecurrencePattern.${attribute} is not valid for ${params.RecurrenceType}`);
    }
  }
}

/** Emit an IfcRecurrencePattern, plus any IfcTimePeriod entities it references. */
function emitRecurrencePattern(params: RecurrencePatternParams, emit: EmitEntity): number {
  validateRecurrencePattern(params);
  const periodIds = (params.TimePeriods ?? []).map(tp =>
    emit('IFCTIMEPERIOD', `'${esc(tp.StartTime)}','${esc(tp.EndTime)}'`));
  // [0] RecurrenceType, [1] DayComponent, [2] WeekdayComponent,
  // [3] MonthComponent, [4] Position, [5] Interval, [6] Occurrences,
  // [7] TimePeriods
  return emit('IFCRECURRENCEPATTERN',
    `${optEnum(params.RecurrenceType)},${intList(params.DayComponent)},${intList(params.WeekdayComponent)},`
    + `${intList(params.MonthComponent)},${optInt(params.Position)},${optInt(params.Interval)},`
    + `${optInt(params.Occurrences)},${refList(periodIds)}`);
}

/**
 * Emit one IfcWorkTime, preceded by its IfcRecurrencePattern (and that
 * pattern's IfcTimePeriod entities) when the entry carries one.
 */
function emitWorkTime(params: WorkTimeParams, emit: EmitEntity): number {
  const recurrenceRef = params.RecurrencePattern !== undefined
    ? `#${emitRecurrencePattern(params.RecurrencePattern, emit)}`
    : '$';
  // IfcWorkTime = IfcSchedulingTime(Name, DataOrigin, UDDataOrigin) +
  //               RecurrencePattern, Start, Finish (both IfcDate).
  return emit('IFCWORKTIME',
    `${optStr(params.Name)},${optEnum(params.DataOrigin)},${optStr(params.UserDefinedDataOrigin)},`
    + `${recurrenceRef},${optStr(params.Start)},${optStr(params.Finish)}`);
}

/**
 * Emit an IfcWorkCalendar and every nested IfcWorkTime in its WorkingTimes
 * and ExceptionTimes lists. Returns the calendar's express id.
 */
export function emitWorkCalendar(
  params: WorkCalendarParams,
  globalId: string,
  ownerRef: string,
  emit: EmitEntity,
): number {
  const workingIds = (params.WorkingTimes ?? []).map(wt => emitWorkTime(wt, emit));
  const exceptionIds = (params.ExceptionTimes ?? []).map(wt => emitWorkTime(wt, emit));
  // IFC4 IfcWorkCalendar (IfcControl, NOT IfcWorkControl — so no
  // CreationDate / StartTime / FinishTime that IfcWorkSchedule carries):
  // [0] GlobalId, [1] OwnerHistory, [2] Name, [3] Description,
  // [4] ObjectType, [5] Identification, [6] WorkingTimes,
  // [7] ExceptionTimes, [8] PredefinedType
  return emit('IFCWORKCALENDAR',
    `'${globalId}',${ownerRef},'${esc(params.Name)}',${optStr(params.Description)},`
    + `${optStr(params.ObjectType)},${optStr(params.Identification)},`
    + `${refList(workingIds)},${refList(exceptionIds)},${optEnum(params.PredefinedType)}`);
}

/**
 * Emit an IfcTaskTime from an `addIfcTask` call's time fields. Callers only
 * reach this when at least one of those fields is set — see
 * `IfcCreator.addIfcTask`.
 */
export function emitTaskTime(params: TaskParams, emit: EmitEntity): number {
  // [0] Name, [1] DataOrigin, [2] UserDefinedDataOrigin,
  // [3] DurationType, [4] ScheduleDuration, [5] ScheduleStart, [6] ScheduleFinish,
  // [7..10] Early/Late Start/Finish, [11] FreeFloat, [12] TotalFloat,
  // [13] IsCritical, [14] StatusTime,
  // [15] ActualDuration, [16] ActualStart, [17] ActualFinish,
  // [18] RemainingTime, [19] Completion
  const attrs: string[] = [
    '$',                                      // Name
    '$',                                      // DataOrigin
    '$',                                      // UserDefinedDataOrigin
    optEnum(params.DurationType),             // DurationType
    optStr(params.ScheduleDuration),          // ScheduleDuration
    optStr(params.ScheduleStart),             // ScheduleStart
    optStr(params.ScheduleFinish),            // ScheduleFinish
    optStr(params.EarlyStart),                // EarlyStart
    optStr(params.EarlyFinish),               // EarlyFinish
    optStr(params.LateStart),                 // LateStart
    optStr(params.LateFinish),                // LateFinish
    optStr(params.FreeFloat),                 // FreeFloat
    optStr(params.TotalFloat),                // TotalFloat
    optBool(params.IsCritical),               // IsCritical
    optStr(params.StatusTime),                // StatusTime
    optStr(params.ActualDuration),            // ActualDuration
    optStr(params.ActualStart),               // ActualStart
    optStr(params.ActualFinish),              // ActualFinish
    optStr(params.RemainingTime),             // RemainingTime
    optReal(params.Completion),               // Completion
  ];
  return emit('IFCTASKTIME', attrs.join(','));
}

/**
 * IFC4 `IfcWorkSchedule` / `IfcWorkPlan` attributes (same layout via IfcWorkControl):
 * GlobalId, OwnerHistory, Name, Description, ObjectType, Identification, CreationDate,
 * Creators, Purpose, Duration, TotalFloat, StartTime, FinishTime, PredefinedType.
 */
export function workControlAttrs(params: WorkScheduleParams, globalId: string, ownerRef: string, nowMs: number): string {
  const creationDate = params.CreationDate ?? new Date(nowMs).toISOString().slice(0, 19);
  return `'${globalId}',${ownerRef},'${esc(params.Name)}',${optStr(params.Description)},$,${optStr(params.Identification)},`
    + `'${esc(creationDate)}',$,${optStr(params.Purpose)},${optStr(params.Duration)},${optStr(params.TotalFloat)},`
    + `'${esc(params.StartTime)}',${optStr(params.FinishTime)},${optEnum(params.PredefinedType)}`;
}

/** The error for scheduling data IFC2X3 cannot represent with these writers. */
export function ifc2x3Unsupported(op: string, what: string): Error {
  return new Error(`${op}: ${what} are not supported for IFC2X3. Create the model as IFC4 or IFC4X3.`);
}
