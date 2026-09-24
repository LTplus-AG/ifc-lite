/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IfcControl side of the schedule walk — the three IfcControl subtypes
 * `schedule-extractor.ts` resolves (IfcWorkSchedule, IfcWorkPlan,
 * IfcWorkCalendar), plus the calendar branch of its IfcRelAssignsToControl
 * pass. Split out of `schedule-extractor.ts` purely to keep both files
 * under the ~400-line module-size guideline (see AGENTS.md) — same reason
 * `schedule-calendar-types.ts` was split from `schedule-types.ts`.
 */

import type { CostEntityReader } from './cost-reader.js';
import type { ScheduleTaskInfo, WorkScheduleInfo } from './schedule-types.js';
import { WORK_SCHEDULE_ATTR, WORK_PLAN_ATTR, asString, asEnum } from './schedule-types.js';
import { extractWorkCalendar } from './schedule-calendar-types.js';
import type { WorkCalendarInfo } from './schedule-calendar-types.js';

/**
 * Decode one IfcWorkSchedule or IfcWorkPlan. Both go through IfcWorkControl
 * and share an identical attribute layout, so `kind` picks the record's
 * label rather than a different set of indices. `globalIdByExpressId` is the
 * caller's shared express-id -> GlobalId map, recorded here so the later
 * passes can resolve a schedule by either key.
 */
export function extractWorkScheduleInfo(
  reader: CostEntityReader,
  expressId: number,
  kind: 'WorkSchedule' | 'WorkPlan',
  globalIdByExpressId: Map<number, string>,
): WorkScheduleInfo | null {
  const entity = reader.get(expressId);
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
}

/** Extract every IFCWORKCALENDAR express id into a WorkCalendarInfo, keyed both as a flat list and by express id (for the assignment walk below). */
export function extractWorkCalendars(
  reader: CostEntityReader,
  workCalendarIds: readonly number[],
): { workCalendars: WorkCalendarInfo[]; calendarByExpressId: Map<number, WorkCalendarInfo> } {
  const workCalendars: WorkCalendarInfo[] = [];
  const calendarByExpressId = new Map<number, WorkCalendarInfo>();
  for (const id of workCalendarIds) {
    const info = extractWorkCalendar(reader, id);
    if (info) {
      workCalendars.push(info);
      calendarByExpressId.set(id, info);
    }
  }
  return { workCalendars, calendarByExpressId };
}

/**
 * Given one IfcRelAssignsToControl's already-decoded RelatingControl id and
 * RelatedObjects, check whether RelatingControl resolves to a calendar
 * (rather than a schedule/work-plan, which the caller's own branch handles)
 * and if so populate `calendarGlobalIds` on every related task/schedule it
 * resolves to. A task or schedule can carry both a controlling schedule AND
 * a calendar via two separate IfcRelAssignsToControl relation instances —
 * this only ever touches `calendarGlobalIds`, so it never clobbers
 * `controllingScheduleGlobalIds`/`taskGlobalIds` populated by the caller's
 * schedule-control branch for a *different* relation.
 *
 * Returns true when this relation WAS a calendar assignment, so the caller
 * knows to skip its own schedule/work-plan handling for it.
 */
export function tryAssignCalendar(
  controlId: number,
  objects: number[],
  calendarByExpressId: Map<number, WorkCalendarInfo>,
  taskByExpressId: Map<number, ScheduleTaskInfo>,
  scheduleByExpressId: Map<number, WorkScheduleInfo>,
): boolean {
  const calendar = calendarByExpressId.get(controlId);
  if (!calendar) return false;
  for (const objId of objects) {
    const task = taskByExpressId.get(objId);
    if (task) {
      const ids = (task.calendarGlobalIds ??= []);
      if (!ids.includes(calendar.globalId)) ids.push(calendar.globalId);
      continue;
    }
    const schedule = scheduleByExpressId.get(objId);
    if (schedule) {
      const ids = (schedule.calendarGlobalIds ??= []);
      if (!ids.includes(calendar.globalId)) ids.push(calendar.globalId);
    }
  }
  return true;
}
