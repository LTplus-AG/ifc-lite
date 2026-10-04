/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schedule (4D) data shapes — IfcTask, IfcRelSequence, IfcWorkSchedule /
 * IfcWorkPlan, and IfcWorkCalendar with the IfcWorkTime /
 * IfcRecurrencePattern / IfcTimePeriod entities it owns.
 *
 * Shapes mirror `@ifc-lite/parser`'s `ScheduleExtraction` struct so the SDK
 * layer stays serializable across the sandbox/transport boundary without
 * pulling the parser into consumer bundles.
 *
 * A sibling of `types.ts` (like `structural-types.ts` next door) rather than
 * a section inside it, so that file stays under its recorded module-size
 * budget. `types.ts` re-exports everything here, so no import path changes.
 */

export type ScheduleSequenceType =
  | 'START_START' | 'START_FINISH' | 'FINISH_START' | 'FINISH_FINISH'
  | 'USERDEFINED' | 'NOTDEFINED';

export type ScheduleTaskDurationType =
  | 'WORKTIME' | 'ELAPSEDTIME' | 'NOTDEFINED';

export interface ScheduleTaskTimeData {
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
  statusTime?: string;
  durationType?: ScheduleTaskDurationType;
  isCritical?: boolean;
  completion?: number;
}

export interface ScheduleTaskData {
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
  taskTime?: ScheduleTaskTimeData;
  parentGlobalId?: string;
  childGlobalIds: string[];
  /** Products assigned via IfcRelAssignsToProcess (the task's inputs). */
  productExpressIds: number[];
  productGlobalIds: string[];
  /** Products the task outputs via IfcRelAssignsToProduct (#6749). Absent ≡ `[]`. */
  outputProductExpressIds?: number[];
  outputProductGlobalIds?: string[];
  controllingScheduleGlobalIds: string[];
  /** IfcWorkCalendar globalIds assigned to this task via IfcRelAssignsToControl. */
  calendarGlobalIds?: string[];
}

export interface ScheduleSequenceData {
  globalId: string;
  relatingTaskGlobalId: string;
  relatedTaskGlobalId: string;
  sequenceType: ScheduleSequenceType;
  userDefinedSequenceType?: string;
  timeLagSeconds?: number;
  timeLagDuration?: string;
}

export interface WorkScheduleData {
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
  taskGlobalIds: string[];
  /** IfcWorkCalendar globalIds assigned to this schedule/plan via IfcRelAssignsToControl. */
  calendarGlobalIds?: string[];
}

/** One StartTime/EndTime pair from an IfcRecurrencePattern's TimePeriods list. */
export interface TimePeriodData {
  start: string;
  end: string;
}

/** IfcRecurrencePattern — the repeat rule an IfcWorkTime may carry. */
export interface RecurrencePatternData {
  recurrenceType?: string;
  dayComponent: number[];
  weekdayComponent: number[];
  monthComponent: number[];
  position?: number;
  interval?: number;
  occurrences?: number;
  timePeriods: TimePeriodData[];
}

/** IfcWorkTime — one working or exception period on an IfcWorkCalendar. */
export interface WorkTimeData {
  name?: string;
  dataOrigin?: string;
  userDefinedDataOrigin?: string;
  recurrencePattern?: RecurrencePatternData;
  start?: string;
  finish?: string;
}

export interface WorkCalendarData {
  expressId: number;
  globalId: string;
  name: string;
  description?: string;
  objectType?: string;
  identification?: string;
  predefinedType?: string;
  workingTimes: WorkTimeData[];
  exceptionTimes: WorkTimeData[];
}

export interface ScheduleExtractionData {
  workSchedules: WorkScheduleData[];
  tasks: ScheduleTaskData[];
  sequences: ScheduleSequenceData[];
  workCalendars: WorkCalendarData[];
  hasSchedule: boolean;
}

export interface ScheduleBackendMethods {
  /** Extract the full schedule graph from the active or specified model. */
  data(modelId?: string): ScheduleExtractionData;
  /** Convenience — just the task list. */
  tasks(modelId?: string): ScheduleTaskData[];
  /** Convenience — just the work schedules / work plans. */
  workSchedules(modelId?: string): WorkScheduleData[];
  /** Convenience — just the task dependency edges. */
  sequences(modelId?: string): ScheduleSequenceData[];
}
