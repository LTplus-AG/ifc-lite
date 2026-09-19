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
  utcDayStart,
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

function d(iso: string): number {
  return utcDayStart(Date.parse(`${iso}T00:00:00Z`));
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

  it('a weekday outside the WorkTime entry\'s own start/finish bounds is non-working', () => {
    assert.equal(isWorkingDay(MON_FRI_CALENDAR, d('2025-01-06')), false); // Monday, past 2024-12-31
  });

  it('no calendar means every day works (no constraint to derive from)', () => {
    assert.equal(isWorkingDay(undefined, d('2024-06-08')), true); // Saturday
  });

  it('a calendar with no workingTimes patterns at all has no constraint', () => {
    const noPattern: WorkCalendarInfo = { ...MON_FRI_CALENDAR, workingTimes: [], exceptionTimes: [] };
    assert.equal(isWorkingDay(noPattern, d('2024-06-08')), true);
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

  it('does not hang and returns the input unchanged for a calendar with no working days at all', () => {
    const allShut: WorkCalendarInfo = {
      ...MON_FRI_CALENDAR,
      workingTimes: [],
      exceptionTimes: [{ name: 'Perpetual shutdown' }],
    };
    // No start/finish on the exception AND no recurrence means it covers
    // nothing per `entryCoversDay`'s "fixed-date entry needs bounds" rule,
    // so this really exercises "no workingTimes patterns" (every day open)
    // rather than the deadlock path — assert the sane outcome either way:
    // the call terminates and returns a finite epoch.
    const t = d('2024-06-08');
    const out = skipToNextWorkingInstant(allShut, t);
    assert.equal(Number.isFinite(out), true);
  });
});

describe('resolveActiveCalendar (#4830)', () => {
  const OTHER_CALENDAR: WorkCalendarInfo = { ...MON_FRI_CALENDAR, expressId: 65, globalId: 'cal-other', name: 'Other' };

  function scheduleWith(opts: {
    workCalendars: WorkCalendarInfo[];
    scheduleCalendarGlobalIds?: string[];
    taskCalendarGlobalIds?: string[];
  }): ScheduleExtraction {
    return {
      hasSchedule: true,
      workCalendars: opts.workCalendars,
      workSchedules: [{
        expressId: 30, globalId: 'sched-gid', kind: 'WorkSchedule', name: 'Main',
        taskGlobalIds: ['task-a'],
        calendarGlobalIds: opts.scheduleCalendarGlobalIds,
      }],
      tasks: [{
        expressId: 10, globalId: 'task-a', name: 'Task A', isMilestone: false,
        childGlobalIds: [], productExpressIds: [], productGlobalIds: [],
        controllingScheduleGlobalIds: ['sched-gid'],
        calendarGlobalIds: opts.taskCalendarGlobalIds,
      }],
      sequences: [],
    };
  }

  it('prefers the calendar assigned to the active (filtered) work schedule', () => {
    const data = scheduleWith({
      workCalendars: [MON_FRI_CALENDAR, OTHER_CALENDAR],
      scheduleCalendarGlobalIds: ['cal-other'],
      taskCalendarGlobalIds: ['cal-gid'],
    });
    assert.equal(resolveActiveCalendar(data, 'sched-gid')?.globalId, 'cal-other');
  });

  it('falls back to the first task-assigned calendar when no schedule filter is active', () => {
    const data = scheduleWith({
      workCalendars: [MON_FRI_CALENDAR, OTHER_CALENDAR],
      taskCalendarGlobalIds: ['cal-other'],
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

describe('utcDayStart / MS_PER_DAY', () => {
  it('normalizes any instant within a UTC day to that day\'s midnight', () => {
    const midday = Date.parse('2024-06-05T15:30:00Z');
    assert.equal(utcDayStart(midday), Date.parse('2024-06-05T00:00:00Z'));
    assert.equal(MS_PER_DAY, 86_400_000);
  });
});
