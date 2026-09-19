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
 * Gantt UI needs: "is this calendar day a working day" and "advance
 * playback time past a non-working span."
 *
 * Dates are handled as LOCAL calendar days, matching `schedule-utils.ts`'s
 * `computeTicks` (the timeline's own day/week tick generator, which uses
 * local `Date` getters/setters, e.g. `new Date(y, m, d)` /
 * `.setDate(.getDate() + 1)`). Using a different basis here (an earlier
 * revision floored to UTC midnight) would put shading and playback out of
 * step with the displayed tick grid by a full timezone offset outside UTC
 * — review caught this on #4982. `localDayStart`/`nextLocalDayStart` below
 * step via `Date` field setters rather than `+= 86_400_000` so a DST
 * transition day (23h or 25h long) still lands on the correct next
 * midnight; `work-calendar.test.ts` has a `TZ=America/Los_Angeles` case
 * spanning a DST boundary.
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
 *    plant shutdowns) — UNLESS the exception entry itself carries
 *    `RecurrencePattern.TimePeriods`, in which case it's describing
 *    DIFFERENT HOURS that day ("half-day Fridays: 08:00-12:00"), not a
 *    closure, and the day stays working at this module's day-level
 *    granularity (#4982 review). An exception with no periods (a bare
 *    `start`/`finish` range, the common holiday/shutdown shape) has
 *    nothing but "this day is an exception" to go on, so that one DOES
 *    shut the day down, matching any exception entry (by explicit
 *    `start`/`finish` range when there's no recurrence, or by the same
 *    `WEEKLY` weekday match when there is).
 *  - A calendar with NO usable working pattern carries NO constraint at
 *    all — every day is working, exceptions included. This covers two
 *    cases the same way, both caught on review:
 *      1. `workingTimes` is empty outright.
 *      2. every `workingTimes` entry uses a recurrence type this module
 *         doesn't interpret (`DAILY`, `MONTHLY_*`, ...). Rejecting those
 *         entries while still treating a non-empty `workingTimes` as "the
 *         calendar constrains something" would read an unsupported
 *         pattern as a total shutdown — worse than not deriving anything.
 *    A `workingTimes` array that mixes one `WEEKLY` entry with an
 *    unsupported one is NOT this case: the `WEEKLY` entry still
 *    constrains normally, and the unsupported entry simply never matches
 *    (see `entryCoversDay`) — a no-op for that one entry, not a shutdown.
 */

import type { ScheduleExtraction, WorkCalendarInfo, WorkTimeInfo } from '@ifc-lite/parser';

export const MS_PER_DAY = 86_400_000;

/** IFC `IfcDayInWeekNumber`: 1=Monday..7=Sunday. Convert a local epoch ms to it. */
function ifcWeekday(epochMs: number): number {
  const jsDay = new Date(epochMs).getDay(); // 0=Sunday..6=Saturday, LOCAL
  return jsDay === 0 ? 7 : jsDay;
}

/** Local midnight for the day containing `epochMs` (same basis as `computeTicks`'s day/week ticks). */
export function localDayStart(epochMs: number): number {
  const d = new Date(epochMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * The next local midnight after `dayStartMs` (which must already be a
 * local-midnight instant). Steps via `Date` field setters, not
 * `+ MS_PER_DAY` — the calendar day spanning a DST transition is 23h or
 * 25h long, and `setDate` accounts for that the same way `computeTicks`
 * does; a flat millisecond add would land mid-day or double-count.
 */
export function nextLocalDayStart(dayStartMs: number): number {
  const d = new Date(dayStartMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/**
 * `WorkTimeInfo.start`/`finish` are `IfcDate` — a bare civil date with no
 * timezone (`'2024-08-01'`). An earlier revision ran this through
 * `Date.parse` (which the ECMAScript spec anchors a date-only string to
 * UTC midnight) and then bucketed that instant into a local calendar day —
 * in a negative-UTC-offset timezone (`America/*`), UTC midnight is still
 * the PREVIOUS local evening, so a `'2024-08-01'` bound silently became
 * July 31 (#4982 review). `IfcDate` names a civil date, not an instant, so
 * this parses the `YYYY-MM-DD` components directly into a local `Date`
 * constructor call — the same "local calendar fields, not a UTC instant"
 * basis `localDayStart`/`nextLocalDayStart` already use — with no UTC
 * round-trip to drift across.
 */
function parseIfcDateLocal(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return undefined;
  const [, y, mo, day] = m;
  return new Date(Number(y), Number(mo) - 1, Number(day)).getTime();
}

/** Does `dayStart` (a local-midnight epoch) fall within `entry`'s start/finish bounds, if any are set? */
function withinBounds(entry: WorkTimeInfo, dayStart: number): boolean {
  const start = parseIfcDateLocal(entry.start);
  const finish = parseIfcDateLocal(entry.finish);
  if (start !== undefined && dayStart < start) return false;
  if (finish !== undefined && dayStart > finish) return false;
  return true;
}

/**
 * Can this entry EVER match a day per `entryCoversDay`'s own rules —
 * not just "is its recurrence type one we interpret"? A `WEEKLY` pattern
 * with an empty `weekdayComponent`, or a pattern-less entry with no
 * `start`/`finish`, is a recognized SHAPE but structurally unmatchable —
 * `entryCoversDay` always returns false for it, the same as a genuinely
 * unsupported recurrence type. Mirroring only the "is it WEEKLY / is it
 * pattern-less" check here (an earlier revision did) let a `workingTimes`
 * array containing ONLY such unmatchable entries read as "the calendar has
 * a real pattern" — non-empty, so `isWorkingDay` fell through to its
 * per-entry loop, which then matched nothing on any day: a total shutdown,
 * the exact bug this whole check exists to prevent (#4982 review).
 */
function isRecognizedPattern(entry: WorkTimeInfo): boolean {
  const pattern = entry.recurrencePattern;
  if (!pattern) return entry.start !== undefined || entry.finish !== undefined;
  return pattern.recurrenceType === 'WEEKLY' && pattern.weekdayComponent.length > 0;
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
  // "WEEKLY only" cut the module doc above states. `isWorkingDay` decides
  // separately whether an all-unsupported `workingTimes` means "no
  // constraint" rather than reading this as "never matches -> shutdown."
  return false;
}

/**
 * Is `epochMs`'s local calendar day a working day per `calendar`?
 * `calendar === undefined` means "no calendar constraint" — every day works.
 */
export function isWorkingDay(calendar: WorkCalendarInfo | undefined, epochMs: number): boolean {
  if (!calendar) return true;
  // No usable working pattern -> no constraint at all, exceptions included
  // (see the module doc's "no usable working pattern" case).
  if (!calendar.workingTimes.some(isRecognizedPattern)) return true;
  const dayStart = localDayStart(epochMs);
  // Every exception entry that covers this day, closure and reduced-hours
  // alike — collected up front rather than branched on during the walk, so
  // a closure encountered anywhere in the array always wins regardless of
  // where a reduced-hours entry for the same day happens to sit (#4982
  // review: an earlier per-entry `continue`/`return false` walk let
  // iteration order mask which entry "won").
  const matchingExceptions = calendar.exceptionTimes.filter(e => entryCoversDay(e, dayStart));
  if (matchingExceptions.length > 0) {
    const hasClosure = matchingExceptions.some(
      e => (e.recurrencePattern?.timePeriods.length ?? 0) === 0,
    );
    if (hasClosure) return false;
    // Every matching exception carries `RecurrencePattern.TimePeriods` —
    // e.g. "half-day Saturdays: 10:00-14:00" — describing DIFFERENT HOURS
    // that day, not a closure (`IfcWorkTime.TimePeriods` is exactly the
    // field that would carry "still open, just shorter"). At this
    // module's day-level granularity that means the day IS working, even
    // when the normal weekly pattern wouldn't otherwise cover it (a
    // reduced-hours Saturday exception opens a day the base Mon-Fri
    // pattern never would) — so this returns `true` directly rather than
    // falling through to the `workingTimes` loop below.
    return true;
  }
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
 * per-row.
 *
 * With a work-schedule filter active (`activeWorkScheduleGlobalId` set):
 *  1. The calendar assigned to that schedule directly, if its
 *     `calendarGlobalIds` resolves.
 *  2. Otherwise, the first calendar assigned to one of THAT schedule's own
 *     tasks (via `controllingScheduleGlobalIds`) — not any task in the
 *     file. An earlier revision scanned every task regardless of the
 *     filter, so a Gantt filtered to one schedule could shade/skip using
 *     an unrelated schedule's working week (#4982 review).
 *  3. Otherwise `undefined` — deliberately, NOT a file-wide fallback.
 *     Falling back to `data.workCalendars[0]` here would pick some OTHER
 *     schedule's calendar (or a calendar assigned to nothing) whenever the
 *     filtered schedule happens to have none of its own; that reads as
 *     "this schedule's working week" while actually being an unrelated
 *     guess. "No calendar resolved" (every day works, no shading) is the
 *     honest answer when scoped to a specific schedule (also #4982 review
 *     — an earlier revision fell through to `workCalendars[0]` here too).
 *
 * With NO filter active:
 *  1. The first calendar referenced by any task's `calendarGlobalIds`, in
 *     task order — there's no specific schedule to stay honest about, so a
 *     project-wide "does ANY calendar apply" guess is reasonable.
 *  2. Otherwise, the first entry in `data.workCalendars`.
 *  3. Otherwise `undefined` — no calendar in the file, so every day works.
 */
export function resolveActiveCalendar(
  data: ScheduleExtraction | null | undefined,
  activeWorkScheduleGlobalId?: string | null,
): WorkCalendarInfo | undefined {
  if (!data || !data.workCalendars || data.workCalendars.length === 0) return undefined;
  const byGlobalId = new Map(data.workCalendars.map(c => [c.globalId, c] as const));
  const resolve = (gids: string[] | undefined): WorkCalendarInfo | undefined => {
    for (const gid of gids ?? []) {
      const cal = byGlobalId.get(gid);
      if (cal) return cal;
    }
    return undefined;
  };

  if (activeWorkScheduleGlobalId) {
    const schedule = data.workSchedules.find(s => s.globalId === activeWorkScheduleGlobalId);
    const viaSchedule = resolve(schedule?.calendarGlobalIds);
    if (viaSchedule) return viaSchedule;
    for (const task of data.tasks) {
      if (!task.controllingScheduleGlobalIds.includes(activeWorkScheduleGlobalId)) continue;
      const viaTask = resolve(task.calendarGlobalIds);
      if (viaTask) return viaTask;
    }
    return undefined;
  }

  for (const task of data.tasks) {
    const viaTask = resolve(task.calendarGlobalIds);
    if (viaTask) return viaTask;
  }
  return data.workCalendars[0];
}

/**
 * Absolute sanity ceiling on how many calendar days a single search may
 * step through, purely to bound file-supplied/malformed input (a reversed
 * or absurd range) per AGENTS.md's "work budget" walk-bounding guidance —
 * NOT a real-world schedule-length limit. ~200 years, so no legitimate
 * construction schedule or shutdown period ever hits it (an earlier
 * revision used a ~10-year cap tied to the same constant that also
 * bounded `getNonWorkingDayStarts`'s legitimate range walk, silently
 * truncating a schedule or shutdown longer than that — caught on review;
 * see `getNonWorkingDayStarts`, which now bounds itself by the requested
 * range instead).
 */
const SANITY_SPAN_MS = 200 * 365 * MS_PER_DAY;

/**
 * Local-midnight starts of every non-working day in `[rangeStart, rangeEnd]`,
 * for shading the Gantt timeline background. Returns an empty array when
 * there's no calendar constraint (see `isWorkingDay`) or the range is
 * degenerate. Bounded by the requested range itself (not a fixed day
 * count) plus `SANITY_SPAN_MS` as a pure malformed-input backstop, so a
 * legitimately long schedule is never silently truncated.
 */
export function getNonWorkingDayStarts(
  calendar: WorkCalendarInfo | undefined,
  rangeStart: number,
  rangeEnd: number,
): number[] {
  if (!calendar || rangeEnd <= rangeStart) return [];
  const out: number[] = [];
  const end = localDayStart(rangeEnd);
  const sanityEnd = rangeStart + SANITY_SPAN_MS;
  let day = localDayStart(rangeStart);
  while (day <= end && day <= sanityEnd) {
    if (!isWorkingDay(calendar, day)) out.push(day);
    day = nextLocalDayStart(day);
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
 * `boundMs` caps the search — callers with a natural horizon (the
 * schedule's own range end) should pass it; it defaults to
 * `SANITY_SPAN_MS` out, a pure malformed-input backstop, when omitted.
 * Returns `null`, never the stale input instant, when no working day
 * exists in `[epochMs, boundMs]` — an earlier revision returned `epochMs`
 * unchanged in that case, which a caller could mistake for "already
 * working" (caught on review). Callers decide what "no working day ahead"
 * means for them (`playbackSlice.ts` treats it like reaching the range end).
 */
export function skipToNextWorkingInstant(
  calendar: WorkCalendarInfo | undefined,
  epochMs: number,
  boundMs: number = epochMs + SANITY_SPAN_MS,
): number | null {
  if (!calendar) return epochMs;
  if (isWorkingDay(calendar, epochMs)) return epochMs;
  let day = localDayStart(epochMs);
  for (;;) {
    day = nextLocalDayStart(day);
    if (day > boundMs) return null;
    if (isWorkingDay(calendar, day)) return day;
  }
}
