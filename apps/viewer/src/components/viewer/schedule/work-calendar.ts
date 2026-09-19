/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * work-calendar — pure working/non-working-day computation from an
 * extracted `IfcWorkCalendar` (`WorkCalendarInfo`, see
 * `@ifc-lite/parser`'s `schedule-calendar-types.ts`).
 *
 * `schedule-extractor.ts` already resolves `IfcWorkCalendar` /
 * `IfcWorkTime` / `IfcRecurrencePattern` into `ScheduleExtraction`
 * (#4830, PR #4835), but round-tripping and displaying a badge is where
 * that PR deliberately stopped — nothing derives working-day-aware dates
 * from the calendar. This module is that derivation, scoped to what the
 * Gantt UI needs: "is this UTC day a working day" and "advance playback
 * time past a non-working span."
 *
 * All dates are handled as UTC calendar days. `IfcDate`/`IfcDateTime`
 * strings from the extractor (`WorkTimeInfo.start`/`finish`,
 * `ScheduleTaskTimeInfo.scheduleStart`/...) parse via `Date.parse`, which
 * treats a bare `YYYY-MM-DD` as UTC midnight — consistent day boundaries
 * regardless of the viewer's local timezone, and deterministic for tests.
 *
 * Semantics (IFC4/IFC4X3 `IfcWorkCalendar`):
 *  - `workingTimes` define the calendar's normal working pattern. Only a
 *    `WEEKLY` `RecurrencePattern` with a `weekdayComponent` is honoured —
 *    the same "one level, not a general RRULE interpreter" scope call the
 *    extractor's own docs make for `TimePeriods`. A day matches a working
 *    entry when its ISO weekday (`IfcDayInWeekNumber`, 1=Monday..7=Sunday)
 *    is listed AND the day falls within that entry's `start`/`finish`
 *    bounds, if present.
 *  - `exceptionTimes` OVERRIDE the working pattern for the days they
 *    cover — that is what "exception" means in the schema (holidays,
 *    plant shutdowns). A day matching any exception entry (by explicit
 *    `start`/`finish` range when there's no recurrence, or by the same
 *    `WEEKLY` weekday match when there is) is always non-working,
 *    regardless of what the working pattern says.
 *  - A calendar with NO `workingTimes` patterns at all carries no
 *    constraint — every day is treated as working, since there is nothing
 *    to derive a Mon-Fri-style pattern from (matches "absent calendar
 *    data" behaving as a no-op everywhere else in this pipeline).
 */

import type { ScheduleExtraction, WorkCalendarInfo, WorkTimeInfo } from '@ifc-lite/parser';

export const MS_PER_DAY = 86_400_000;

/** IFC `IfcDayInWeekNumber`: 1=Monday..7=Sunday. Convert a UTC epoch ms to it. */
function ifcWeekday(epochMs: number): number {
  const jsDay = new Date(epochMs).getUTCDay(); // 0=Sunday..6=Saturday
  return jsDay === 0 ? 7 : jsDay;
}

/** UTC midnight for the day containing `epochMs`. */
export function utcDayStart(epochMs: number): number {
  return Math.floor(epochMs / MS_PER_DAY) * MS_PER_DAY;
}

function parseIfcDateUtc(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? utcDayStart(ms) : undefined;
}

/** Does `dayStart` (a UTC-midnight epoch) fall within `entry`'s start/finish bounds, if any are set? */
function withinBounds(entry: WorkTimeInfo, dayStart: number): boolean {
  const start = parseIfcDateUtc(entry.start);
  const finish = parseIfcDateUtc(entry.finish);
  if (start !== undefined && dayStart < start) return false;
  if (finish !== undefined && dayStart > finish) return false;
  return true;
}

/** Does this `WorkTimeInfo` entry cover `dayStart` — weekly-recurrence match, or (for exceptions) a bare date range? */
function entryCoversDay(entry: WorkTimeInfo, dayStart: number): boolean {
  const pattern = entry.recurrencePattern;
  if (pattern && pattern.recurrenceType === 'WEEKLY') {
    if (pattern.weekdayComponent.length === 0) return false;
    if (!pattern.weekdayComponent.includes(ifcWeekday(dayStart))) return false;
    return withinBounds(entry, dayStart);
  }
  if (!pattern) {
    // No recurrence: a fixed-date entry, only meaningful with explicit bounds.
    if (entry.start === undefined && entry.finish === undefined) return false;
    return withinBounds(entry, dayStart);
  }
  // Other recurrence kinds (DAILY, MONTHLY_*, ...) are out of scope — same
  // "WEEKLY only" cut the module doc above states.
  return false;
}

/**
 * Is `epochMs`'s UTC calendar day a working day per `calendar`?
 * `calendar === undefined` means "no calendar constraint" — every day works.
 */
export function isWorkingDay(calendar: WorkCalendarInfo | undefined, epochMs: number): boolean {
  if (!calendar) return true;
  const dayStart = utcDayStart(epochMs);
  for (const exception of calendar.exceptionTimes) {
    if (entryCoversDay(exception, dayStart)) return false;
  }
  if (calendar.workingTimes.length === 0) return true;
  for (const working of calendar.workingTimes) {
    if (entryCoversDay(working, dayStart)) return true;
  }
  return false;
}

/**
 * Pick the calendar the Gantt should treat as "assigned" for shading /
 * animation purposes. A file can assign different calendars per task, but
 * the timeline background and playback clock are single, project-wide
 * concerns, so this resolves ONE representative calendar rather than
 * per-row:
 *
 *  1. The calendar assigned to the active (filtered) work schedule, if one
 *     is selected and carries a `calendarGlobalIds` entry that resolves.
 *  2. Otherwise, the first calendar referenced by any task's
 *     `calendarGlobalIds`, in task order.
 *  3. Otherwise, the first entry in `data.workCalendars`.
 *  4. Otherwise `undefined` — no calendar in the file, so every day works.
 */
export function resolveActiveCalendar(
  data: ScheduleExtraction | null | undefined,
  activeWorkScheduleGlobalId?: string | null,
): WorkCalendarInfo | undefined {
  if (!data || !data.workCalendars || data.workCalendars.length === 0) return undefined;
  const byGlobalId = new Map(data.workCalendars.map(c => [c.globalId, c] as const));

  if (activeWorkScheduleGlobalId) {
    const schedule = data.workSchedules.find(s => s.globalId === activeWorkScheduleGlobalId);
    for (const gid of schedule?.calendarGlobalIds ?? []) {
      const cal = byGlobalId.get(gid);
      if (cal) return cal;
    }
  }

  for (const task of data.tasks) {
    for (const gid of task.calendarGlobalIds ?? []) {
      const cal = byGlobalId.get(gid);
      if (cal) return cal;
    }
  }

  return data.workCalendars[0];
}

/**
 * Bound on how many non-working days a single shading/skip computation
 * will walk. Real construction calendars span months to a few years of
 * schedule range; this generously covers a decade while guaranteeing the
 * loops below terminate even on a malformed/huge `range`.
 */
const MAX_DAYS_WALKED = 3660;

/**
 * UTC-midnight starts of every non-working day in `[rangeStart, rangeEnd]`,
 * for shading the Gantt timeline background. Returns an empty array when
 * there's no calendar constraint (see `isWorkingDay`) or the range is
 * degenerate.
 */
export function getNonWorkingDayStarts(
  calendar: WorkCalendarInfo | undefined,
  rangeStart: number,
  rangeEnd: number,
): number[] {
  if (!calendar || rangeEnd <= rangeStart) return [];
  const out: number[] = [];
  let day = utcDayStart(rangeStart);
  const end = utcDayStart(rangeEnd);
  for (let i = 0; day <= end && i < MAX_DAYS_WALKED; i++, day += MS_PER_DAY) {
    if (!isWorkingDay(calendar, day)) out.push(day);
  }
  return out;
}

/**
 * Advance a playback instant so it never lands inside a non-working day:
 * if `epochMs`'s day is non-working, jump forward to the start of the next
 * working day. Used by the playback clock (`advancePlaybackBy`) so
 * auto-play doesn't sit animating nothing across a weekend/holiday.
 *
 * Idempotent on an already-working instant (returns `epochMs` unchanged).
 * Bounded by `MAX_DAYS_WALKED` so a calendar with no working days at all
 * (pathological, but file-supplied data is untrusted per AGENTS.md) can't
 * hang the rAF loop — it returns `epochMs` unchanged in that case.
 */
export function skipToNextWorkingInstant(calendar: WorkCalendarInfo | undefined, epochMs: number): number {
  if (!calendar || isWorkingDay(calendar, epochMs)) return epochMs;
  let day = utcDayStart(epochMs);
  for (let i = 0; i < MAX_DAYS_WALKED; i++) {
    day += MS_PER_DAY;
    if (isWorkingDay(calendar, day)) return day;
  }
  return epochMs;
}
