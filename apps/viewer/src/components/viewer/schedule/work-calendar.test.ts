/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ScheduleExtraction, WorkCalendarInfo } from '@ifc-lite/parser';
import {
  isWorkingDay,
  resolveActiveCalendar,
  getNonWorkingDayStarts,
  skipToNextWorkingInstant,
  localDayStart,
  nextLocalDayStart,
  MS_PER_DAY,
} from './work-calendar.js';

// #4830 — the working-day computation this repo's #4835 PR deliberately
// left out ("deriving working-day-aware dates from IfcRecurrencePattern is
// materially larger"; see GanttTaskTree.tsx's duration-cell comment). This
// file is that derivation: a Mon-Fri weekly calendar with one exception
// period, shaped exactly like `WorkCalendarInfo` as `extractWorkCalendar`
// (`packages/parser/src/schedule-calendar-types.ts`) produces it from a
// real IFCWORKCALENDAR/IFCWORKTIME/IFCRECURRENCEPATTERN STEP triple — that
// STEP→WorkCalendarInfo shape is already covered end to end by
// `packages/parser/test/schedule-extractor.test.ts`'s
// "extracts a bare IfcWorkCalendar with a WorkingTime carrying a
// RecurrencePattern" case, which uses this identical Mon-Fri + exception
// pattern; this file exercises what the Gantt layer derives FROM that
// extracted shape.
//
// `d(iso)` builds a LOCAL midnight instant (matching `localDayStart`'s own
// basis, which matches `schedule-utils.ts`'s `computeTicks`) — deliberately
// NOT `Date.parse` + `Z`, which would anchor to UTC midnight and drift by
// the runner's UTC offset (#4982 review: an earlier revision used UTC
// throughout and shaded/skipped the wrong day outside UTC).
function d(iso: string): number {
  const [y, m, day] = iso.split('-').map(Number);
  return new Date(y, m - 1, day).getTime();
}

/** Mon–Fri 08:00–17:00 weekly, bounded 2024-05-01..2024-12-31, with a 2024-08-01..2024-08-14 shutdown exception. */
const MON_FRI_CALENDAR: WorkCalendarInfo = {
  expressId: 64,
  globalId: 'cal-gid',
  name: 'Site calendar',
  workingTimes: [
    {
      name: 'Weekdays',
      start: '2024-05-01',
      finish: '2024-12-31',
      recurrencePattern: {
        recurrenceType: 'WEEKLY',
        dayComponent: [],
        weekdayComponent: [1, 2, 3, 4, 5], // Monday..Friday
        monthComponent: [],
        timePeriods: [{ start: '08:00:00', end: '17:00:00' }],
      },
    },
  ],
  exceptionTimes: [
    { name: 'Shutdown', start: '2024-08-01', finish: '2024-08-14' },
  ],
};

/** Same Mon-Fri pattern, no `start`/`finish` bounds on the entries — used by the DST test so it never touches the bare-`IfcDate` UTC-anchoring edge case `parseIfcDateLocal`'s doc comment flags. */
const MON_FRI_UNBOUNDED_CALENDAR: WorkCalendarInfo = {
  expressId: 66,
  globalId: 'cal-unbounded',
  name: 'Unbounded weekdays',
  workingTimes: [{
    name: 'Weekdays',
    recurrencePattern: {
      recurrenceType: 'WEEKLY',
      dayComponent: [],
      weekdayComponent: [1, 2, 3, 4, 5],
      monthComponent: [],
      timePeriods: [],
    },
  }],
  exceptionTimes: [],
};

describe('isWorkingDay (#4830)', () => {
  it('treats a mid-week Wednesday within bounds as working', () => {
    assert.equal(isWorkingDay(MON_FRI_CALENDAR, d('2024-06-05')), true); // Wednesday
  });

  it('treats Saturday/Sunday as non-working — not covered by the Mon-Fri pattern', () => {
    assert.equal(isWorkingDay(MON_FRI_CALENDAR, d('2024-06-08')), false); // Saturday
    assert.equal(isWorkingDay(MON_FRI_CALENDAR, d('2024-06-09')), false); // Sunday
  });

  it('exception period overrides the weekday pattern even on a Monday', () => {
    assert.equal(isWorkingDay(MON_FRI_CALENDAR, d('2024-08-05')), false); // Monday, inside shutdown
    // The day right after the shutdown ends is a normal working Thursday.
    assert.equal(isWorkingDay(MON_FRI_CALENDAR, d('2024-08-15')), true);
  });

  it('an exception with NO TimePeriods shuts the day down (the plain shutdown/holiday shape)', () => {
    // Same shape as MON_FRI_CALENDAR's own shutdown exception — a bare
    // start/finish range, no recurrencePattern at all, so no TimePeriods
    // to carry "different hours." Restated explicitly here as the
    // baseline the next two tests contrast against.
    const holiday: WorkCalendarInfo = {
      ...MON_FRI_CALENDAR,
      exceptionTimes: [{ name: 'Public holiday', start: '2024-06-05', finish: '2024-06-05' }],
    };
    assert.equal(isWorkingDay(holiday, d('2024-06-05')), false); // Wednesday, otherwise working
  });

  it('an exception with TimePeriods means DIFFERENT HOURS, not closed — it OPENS an otherwise non-working day (#4982 review)', () => {
    // "Half-day Saturdays in December: 10:00-14:00" — an exception entry
    // whose own RecurrencePattern carries TimePeriods, covering a day
    // (Saturday) the base Mon-Fri pattern does NOT otherwise cover. A
    // Friday would already be working under the base pattern regardless
    // of this logic, so it wouldn't actually prove anything (an earlier
    // revision's test used Friday and passed even when the "must force
    // working" branch was unreachable, per review) — Saturday is the case
    // that only passes if the exception genuinely forces the day open.
    const halfDaySaturdays: WorkCalendarInfo = {
      ...MON_FRI_CALENDAR,
      exceptionTimes: [{
        name: 'Half-day Saturdays',
        start: '2024-12-01',
        finish: '2024-12-31',
        recurrencePattern: {
          recurrenceType: 'WEEKLY',
          dayComponent: [], monthComponent: [],
          weekdayComponent: [6], // Saturday
          timePeriods: [{ start: '10:00:00', end: '14:00:00' }],
        },
      }],
    };
    assert.equal(isWorkingDay(halfDaySaturdays, d('2024-12-07')), true); // Saturday, opened by the exception
    // A December Sunday is untouched by the Saturday-only exception and
    // stays non-working — the exception doesn't open every weekend day,
    // only the one it actually covers.
    assert.equal(isWorkingDay(halfDaySaturdays, d('2024-12-08')), false);
    // A December Monday is untouched too and still working via the
    // normal Mon-Fri pattern (unaffected either way).
    assert.equal(isWorkingDay(halfDaySaturdays, d('2024-12-02')), true);
  });

  it('a closure exception takes precedence over a co-matching TimePeriods exception on the same day, in EITHER array order', () => {
    // #4982 review: collecting every matching exception before deciding
    // (rather than branching per-entry during the walk) means a closure
    // wins regardless of where it sits relative to a reduced-hours entry
    // for the same day.
    const closure = { name: 'Site shutdown', start: '2024-12-07', finish: '2024-12-07' };
    const reducedHours = {
      name: 'Half-day Saturdays',
      start: '2024-12-01',
      finish: '2024-12-31',
      recurrencePattern: {
        recurrenceType: 'WEEKLY' as const,
        dayComponent: [], monthComponent: [],
        weekdayComponent: [6],
        timePeriods: [{ start: '10:00:00', end: '14:00:00' }],
      },
    };
    const closureFirst: WorkCalendarInfo = { ...MON_FRI_CALENDAR, exceptionTimes: [closure, reducedHours] };
    const reducedHoursFirst: WorkCalendarInfo = { ...MON_FRI_CALENDAR, exceptionTimes: [reducedHours, closure] };
    assert.equal(isWorkingDay(closureFirst, d('2024-12-07')), false);
    assert.equal(isWorkingDay(reducedHoursFirst, d('2024-12-07')), false);
  });

  it('a mix of a TimePeriods exception and a plain shutdown exception for DIFFERENT days applies each independently', () => {
    const mixed: WorkCalendarInfo = {
      ...MON_FRI_CALENDAR,
      exceptionTimes: [
        {
          name: 'Half-day Saturdays',
          start: '2024-12-01',
          finish: '2024-12-31',
          recurrencePattern: {
            recurrenceType: 'WEEKLY', dayComponent: [], monthComponent: [],
            weekdayComponent: [6],
            timePeriods: [{ start: '10:00:00', end: '14:00:00' }],
          },
        },
        { name: 'Christmas', start: '2024-12-25', finish: '2024-12-26' },
      ],
    };
    assert.equal(isWorkingDay(mixed, d('2024-12-07')), true); // half-day Saturday, opened by the exception
    assert.equal(isWorkingDay(mixed, d('2024-12-25')), false); // Christmas (a Wednesday), plain shutdown wins
  });

  it('a weekday outside the WorkTime entry\'s own start/finish bounds is non-working', () => {
    assert.equal(isWorkingDay(MON_FRI_CALENDAR, d('2025-01-06')), false); // Monday, past 2024-12-31
  });

  it('no calendar means every day works (no constraint to derive from)', () => {
    assert.equal(isWorkingDay(undefined, d('2024-06-08')), true); // Saturday
  });

  it('a calendar with no workingTimes patterns at all has no constraint — exceptions included', () => {
    // #4982 review: an earlier revision checked exceptionTimes BEFORE the
    // empty-workingTimes case, so a bounded exception could still shade/skip
    // a day despite the calendar otherwise imposing no constraint at all.
    const noPattern: WorkCalendarInfo = {
      ...MON_FRI_CALENDAR,
      workingTimes: [],
      exceptionTimes: [{ name: 'Shutdown', start: '2024-06-01', finish: '2024-06-30' }],
    };
    assert.equal(isWorkingDay(noPattern, d('2024-06-08')), true); // inside the exception's own bounds
  });

  it('a workingTimes array of ONLY unsupported recurrence types has no constraint, not a total shutdown', () => {
    // #4982 review: DAILY (and any non-WEEKLY type) never matches in
    // `entryCoversDay`; treating a non-empty-but-all-unsupported
    // `workingTimes` as "the calendar constrains something" reads that as
    // shutdown every day, which is worse than not deriving anything.
    const dailyOnly: WorkCalendarInfo = {
      ...MON_FRI_CALENDAR,
      workingTimes: [{
        name: 'Daily (unsupported)',
        recurrencePattern: {
          recurrenceType: 'DAILY', dayComponent: [], weekdayComponent: [], monthComponent: [], timePeriods: [],
        },
      }],
      exceptionTimes: [{ name: 'Shutdown', start: '2024-06-01', finish: '2024-06-30' }],
    };
    assert.equal(isWorkingDay(dailyOnly, d('2024-06-08')), true); // Saturday, would be false under the old "empty means open" test alone
    assert.equal(isWorkingDay(dailyOnly, d('2024-06-15')), true); // inside the (now-inert) exception window too
  });

  it('one WEEKLY entry mixed with an unsupported one still constrains normally — the unsupported entry is just a no-op', () => {
    const mixed: WorkCalendarInfo = {
      ...MON_FRI_CALENDAR,
      workingTimes: [
        ...MON_FRI_CALENDAR.workingTimes,
        {
          name: 'Daily (unsupported, ignored)',
          recurrencePattern: {
            recurrenceType: 'DAILY', dayComponent: [], weekdayComponent: [], monthComponent: [], timePeriods: [],
          },
        },
      ],
    };
    assert.equal(isWorkingDay(mixed, d('2024-06-08')), false); // still a non-working Saturday
    assert.equal(isWorkingDay(mixed, d('2024-06-05')), true); // still a working Wednesday
  });

  it('a workingTimes array of ONLY a WEEKLY entry with an empty weekdayComponent has no constraint, not a total shutdown', () => {
    // #4982 review: an earlier revision's `isRecognizedPattern` treated
    // "recurrenceType is WEEKLY" as sufficient, without checking that
    // `weekdayComponent` actually lists any weekday. `entryCoversDay`
    // itself always returns false for an empty `weekdayComponent`
    // (structurally unmatchable), so a `workingTimes` containing only such
    // an entry read as "has a real pattern" (non-empty array) while never
    // matching any day — every day non-working. Same bug class as the
    // all-DAILY case above, different shape.
    const emptyWeekdays: WorkCalendarInfo = {
      ...MON_FRI_CALENDAR,
      workingTimes: [{
        name: 'Empty weekly',
        recurrencePattern: {
          recurrenceType: 'WEEKLY', dayComponent: [], weekdayComponent: [], monthComponent: [], timePeriods: [],
        },
      }],
      exceptionTimes: [{ name: 'Shutdown', start: '2024-06-01', finish: '2024-06-30' }],
    };
    assert.equal(isWorkingDay(emptyWeekdays, d('2024-06-08')), true); // Saturday
    assert.equal(isWorkingDay(emptyWeekdays, d('2024-06-15')), true); // inside the now-inert exception window too
  });

  it('a workingTimes array of ONLY a pattern-less entry with no start/finish has no constraint, not a total shutdown', () => {
    // Same bug class again: a pattern-less `WorkTimeInfo` with neither
    // `start` nor `finish` is a recognized SHAPE (no recurrence = a
    // fixed-date entry) but structurally unmatchable per
    // `entryCoversDay`'s own "only meaningful with explicit bounds" rule.
    const unboundedNoPattern: WorkCalendarInfo = {
      ...MON_FRI_CALENDAR,
      workingTimes: [{ name: 'Unbounded, no recurrence' }],
      exceptionTimes: [{ name: 'Shutdown', start: '2024-06-01', finish: '2024-06-30' }],
    };
    assert.equal(isWorkingDay(unboundedNoPattern, d('2024-06-08')), true); // Saturday
    assert.equal(isWorkingDay(unboundedNoPattern, d('2024-06-15')), true); // inside the now-inert exception window too
  });
});

describe('getNonWorkingDayStarts (#4830)', () => {
  it('returns exactly the weekends plus the shutdown days in a one-week range spanning the shutdown boundary', () => {
    // 2024-08-01 (Thu) .. 2024-08-05 (Mon): all five days are inside the
    // shutdown exception, so all five are non-working despite three being
    // normal Mon-Fri weekdays.
    const days = getNonWorkingDayStarts(MON_FRI_CALENDAR, d('2024-08-01'), d('2024-08-05'));
    assert.deepEqual(days, [
      d('2024-08-01'), d('2024-08-02'), d('2024-08-03'), d('2024-08-04'), d('2024-08-05'),
    ]);
  });

  it('returns just the weekend in an ordinary working week', () => {
    // 2024-06-03 (Mon) .. 2024-06-09 (Sun).
    const days = getNonWorkingDayStarts(MON_FRI_CALENDAR, d('2024-06-03'), d('2024-06-09'));
    assert.deepEqual(days, [d('2024-06-08'), d('2024-06-09')]);
  });

  it('is empty with no calendar', () => {
    assert.deepEqual(getNonWorkingDayStarts(undefined, d('2024-06-03'), d('2024-06-09')), []);
  });

  it('does not truncate a non-working span far longer than the old fixed 3,660-day cap', () => {
    // #4982 review: the previous cap was tied to a fixed day COUNT shared
    // with `skipToNextWorkingInstant`'s pathological-input backstop, so a
    // legitimately long requested range silently lost its tail. A 12-year
    // (~4,380-day) unbounded weekday calendar's weekends must all show up.
    const start = d('2024-01-01');
    const end = d('2036-01-01'); // ~12 years
    const days = getNonWorkingDayStarts(MON_FRI_UNBOUNDED_CALENDAR, start, end);
    // Every returned day must actually be a Saturday or Sunday, and the
    // count must be in the right ballpark for 12 years of weekends
    // (52 * 12 * 2 = 1248, +/- a few for the exact week alignment) — well
    // past the old 3,660-entry-shared cap would have allowed this function
    // to walk before truncating.
    for (const day of days) {
      const dow = new Date(day).getDay();
      assert.ok(dow === 0 || dow === 6, `expected a weekend day, got dow=${dow} for ${new Date(day).toISOString()}`);
    }
    assert.ok(days.length > 1200 && days.length < 1300, `expected ~1248 weekend days, got ${days.length}`);
    // And the LAST one must be near the end of the range, not cut off
    // partway through (the actual bug the old cap produced).
    assert.ok(days[days.length - 1] >= d('2035-12-01'), 'the tail of the range must still be covered');
  });
});

describe('skipToNextWorkingInstant (#4830)', () => {
  it('leaves an already-working instant untouched', () => {
    const noonWednesday = d('2024-06-05') + 12 * 3_600_000;
    assert.equal(skipToNextWorkingInstant(MON_FRI_CALENDAR, noonWednesday), noonWednesday);
  });

  it('jumps a Saturday instant forward to Monday\'s start', () => {
    const saturdayNoon = d('2024-06-08') + 12 * 3_600_000;
    assert.equal(skipToNextWorkingInstant(MON_FRI_CALENDAR, saturdayNoon), d('2024-06-10'));
  });

  it('jumps across the full two-week shutdown exception to the next working day', () => {
    const shutdownStart = d('2024-08-01');
    assert.equal(skipToNextWorkingInstant(MON_FRI_CALENDAR, shutdownStart), d('2024-08-15'));
  });

  it('is a no-op with no calendar', () => {
    const t = d('2024-06-08');
    assert.equal(skipToNextWorkingInstant(undefined, t), t);
  });

  it('returns null, not the stale instant, when no working day exists before the bound', () => {
    // #4982 review: a caller must be able to tell "nothing working ahead"
    // apart from "already working" — an earlier revision returned the
    // original (non-working) instant for both, which a naive caller could
    // read as "this is fine, keep it."
    const saturday = d('2024-06-08');
    const nextWorkingMonday = d('2024-06-10');
    // Bound the search to end BEFORE Monday — no working day in range.
    const bound = nextWorkingMonday - MS_PER_DAY;
    assert.equal(skipToNextWorkingInstant(MON_FRI_CALENDAR, saturday, bound), null);
    // Bound it to land exactly on Monday - now it's found.
    assert.equal(skipToNextWorkingInstant(MON_FRI_CALENDAR, saturday, nextWorkingMonday), nextWorkingMonday);
  });

  it('does not hang and returns a working day for a calendar whose only constraint is inert', () => {
    const allShut: WorkCalendarInfo = {
      ...MON_FRI_CALENDAR,
      workingTimes: [],
      exceptionTimes: [{ name: 'Perpetual shutdown' }],
    };
    // No start/finish on the exception AND no recurrence means it covers
    // nothing (see `entryCoversDay`'s "fixed-date entry needs bounds"
    // rule), and an empty `workingTimes` means no constraint at all — so
    // every day, including this one, is already working.
    const t = d('2024-06-08');
    assert.equal(skipToNextWorkingInstant(allShut, t), t);
  });
});

describe('resolveActiveCalendar (#4830)', () => {
  const OTHER_CALENDAR: WorkCalendarInfo = { ...MON_FRI_CALENDAR, expressId: 65, globalId: 'cal-other', name: 'Other' };

  function scheduleWith(opts: {
    workCalendars: WorkCalendarInfo[];
    scheduleCalendarGlobalIds?: string[];
    taskACalendarGlobalIds?: string[];
    taskBCalendarGlobalIds?: string[];
    taskBSchedule?: string;
  }): ScheduleExtraction {
    return {
      hasSchedule: true,
      workCalendars: opts.workCalendars,
      workSchedules: [
        {
          expressId: 30, globalId: 'sched-gid', kind: 'WorkSchedule', name: 'Main',
          taskGlobalIds: ['task-a'],
          calendarGlobalIds: opts.scheduleCalendarGlobalIds,
        },
        {
          expressId: 31, globalId: 'sched-other', kind: 'WorkSchedule', name: 'Other schedule',
          taskGlobalIds: ['task-b'],
        },
      ],
      tasks: [
        {
          expressId: 10, globalId: 'task-a', name: 'Task A', isMilestone: false,
          childGlobalIds: [], productExpressIds: [], productGlobalIds: [],
          controllingScheduleGlobalIds: ['sched-gid'],
          calendarGlobalIds: opts.taskACalendarGlobalIds,
        },
        {
          expressId: 11, globalId: 'task-b', name: 'Task B', isMilestone: false,
          childGlobalIds: [], productExpressIds: [], productGlobalIds: [],
          controllingScheduleGlobalIds: [opts.taskBSchedule ?? 'sched-other'],
          calendarGlobalIds: opts.taskBCalendarGlobalIds,
        },
      ],
      sequences: [],
    };
  }

  it('prefers the calendar assigned to the active (filtered) work schedule', () => {
    const data = scheduleWith({
      workCalendars: [MON_FRI_CALENDAR, OTHER_CALENDAR],
      scheduleCalendarGlobalIds: ['cal-other'],
      taskACalendarGlobalIds: ['cal-gid'],
    });
    assert.equal(resolveActiveCalendar(data, 'sched-gid')?.globalId, 'cal-other');
  });

  it('does NOT use a calendar assigned to a task from a DIFFERENT schedule than the active filter', () => {
    // #4982 review: the fallback used to scan every task in the file
    // regardless of `activeWorkScheduleGlobalId`. task-b is controlled by
    // sched-other, not the active sched-gid, and neither the active
    // schedule nor task-a carries a calendar — task-b's calendar must NOT
    // be picked up.
    const data = scheduleWith({
      workCalendars: [MON_FRI_CALENDAR, OTHER_CALENDAR],
      taskBCalendarGlobalIds: ['cal-other'],
    });
    assert.equal(resolveActiveCalendar(data, 'sched-gid')?.globalId, undefined);
  });

  it('returns undefined (not a file-wide guess) when a schedule filter is active and NOTHING in its scope carries a calendar', () => {
    // #4982 review, second pass: the previous fix (above) still fell back
    // to `data.workCalendars[0]` — some OTHER schedule's calendar, or one
    // assigned to nothing — which is just as much an unrelated guess as
    // task-b's calendar was. Scoped to a specific schedule, "no calendar
    // resolved" (undefined -> no shading) is the honest answer; only the
    // UNFILTERED path may guess a project-wide default.
    const data = scheduleWith({ workCalendars: [MON_FRI_CALENDAR, OTHER_CALENDAR] });
    assert.equal(resolveActiveCalendar(data, 'sched-gid'), undefined);
    // Confirm the unfiltered path is unaffected — it's still allowed to
    // guess the file-wide first entry.
    assert.equal(resolveActiveCalendar(data, undefined)?.globalId, 'cal-gid');
  });

  it('DOES use a calendar assigned to a task that the active schedule itself controls', () => {
    const data = scheduleWith({
      workCalendars: [MON_FRI_CALENDAR, OTHER_CALENDAR],
      taskACalendarGlobalIds: ['cal-other'], // task-a IS controlled by the active sched-gid
    });
    assert.equal(resolveActiveCalendar(data, 'sched-gid')?.globalId, 'cal-other');
  });

  it('falls back to the first task-assigned calendar when no schedule filter is active', () => {
    const data = scheduleWith({
      workCalendars: [MON_FRI_CALENDAR, OTHER_CALENDAR],
      taskACalendarGlobalIds: ['cal-other'],
    });
    assert.equal(resolveActiveCalendar(data, undefined)?.globalId, 'cal-other');
  });

  it('falls back to the first calendar in the file when nothing is assigned', () => {
    const data = scheduleWith({ workCalendars: [MON_FRI_CALENDAR, OTHER_CALENDAR] });
    assert.equal(resolveActiveCalendar(data, undefined)?.globalId, 'cal-gid');
  });

  it('returns undefined for a file with no calendars', () => {
    const data = scheduleWith({ workCalendars: [] });
    assert.equal(resolveActiveCalendar(data, undefined), undefined);
    assert.equal(resolveActiveCalendar(null, undefined), undefined);
  });
});

describe('localDayStart / nextLocalDayStart / MS_PER_DAY', () => {
  it('normalizes any instant within a local day to that day\'s local midnight', () => {
    const midday = new Date(2024, 5, 5, 15, 30, 0).getTime();
    assert.equal(localDayStart(midday), d('2024-06-05'));
    assert.equal(MS_PER_DAY, 86_400_000);
  });

  it('nextLocalDayStart steps exactly one calendar day, not necessarily 24h', () => {
    assert.equal(nextLocalDayStart(d('2024-06-05')), d('2024-06-06'));
  });
});

describe('DST boundary (#4830, #4982 review — same local-day basis as computeTicks)', () => {
  // 2024-03-10 is the US spring-forward DST transition (America/Los_Angeles
  // loses an hour: 2am -> 3am). A calendar day computation that adds a flat
  // 24h instead of stepping local calendar fields would land the "next day"
  // instant an hour into the WRONG side of the transition. Run this under a
  // real US Pacific TZ so the assertions exercise the actual runtime
  // behaviour (Node re-reads `process.env.TZ` for `Date` local-time
  // calculations; no subprocess needed) — see the surrounding module doc.
  const originalTz = process.env.TZ;

  it('shades/skips the correct local day across a spring-forward transition', () => {
    process.env.TZ = 'America/Los_Angeles';
    try {
      // Sunday 2024-03-10 (the transition day itself) is non-working under
      // the Mon-Fri calendar; the next day, Monday 2024-03-11, is working.
      const sunday = new Date(2024, 2, 10).getTime(); // local midnight, March 10
      const monday = new Date(2024, 2, 11).getTime(); // local midnight, March 11 (23h calendar day later)
      assert.equal(localDayStart(sunday), sunday);
      assert.equal(nextLocalDayStart(sunday), monday);
      assert.equal(isWorkingDay(MON_FRI_UNBOUNDED_CALENDAR, sunday), false);
      assert.equal(isWorkingDay(MON_FRI_UNBOUNDED_CALENDAR, monday), true);
      // A playback instant sitting at Sunday noon (local) must skip forward
      // to exactly Monday's local midnight, not Monday +/- 1h from a flat
      // 24h step across the 23h DST day.
      const sundayNoon = sunday + 12 * 3_600_000;
      assert.equal(skipToNextWorkingInstant(MON_FRI_UNBOUNDED_CALENDAR, sundayNoon), monday);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('parses a bare IfcDate WorkTime bound as its own civil day, not shifted by a negative UTC offset (#4982 review)', () => {
    // America/Los_Angeles is UTC-8 (winter, no DST in play here). Under the
    // OLD implementation (Date.parse anchors a date-only string to UTC
    // midnight, then bucket into a local day), '2024-08-01' would parse to
    // 2024-08-01T00:00:00Z, which is 2024-07-31T17:00 local in LA — a
    // DIFFERENT civil day. The fix parses the Y-M-D components directly
    // into a local `Date`, so the bound lands on August 1st exactly,
    // regardless of the runner's offset sign.
    process.env.TZ = 'America/Los_Angeles';
    try {
      const closureOneDay: WorkCalendarInfo = {
        ...MON_FRI_UNBOUNDED_CALENDAR,
        exceptionTimes: [{ name: 'Closure', start: '2024-08-01', finish: '2024-08-01' }],
      };
      const aug1Local = new Date(2024, 7, 1).getTime(); // Thursday
      const jul31Local = new Date(2024, 6, 31).getTime(); // Wednesday
      assert.equal(isWorkingDay(closureOneDay, aug1Local), false); // shut exactly on Aug 1
      // The old UTC-anchoring bug would have bled the closure back onto
      // July 31st too; it must NOT.
      assert.equal(isWorkingDay(closureOneDay, jul31Local), true);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});
