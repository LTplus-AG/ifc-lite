/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import type { ScheduleExtraction, WorkCalendarInfo } from '@ifc-lite/parser';
import { createPlaybackSlice, type PlaybackSlice } from './playbackSlice.js';
import type { ScheduleTimeRange } from './scheduleSlice.js';

type TestStore = PlaybackSlice & {
  scheduleRange: ScheduleTimeRange | null;
  scheduleData?: ScheduleExtraction | null;
  activeWorkScheduleId?: string;
};

const makeStore = (
  range: ScheduleTimeRange | null,
  scheduleData?: ScheduleExtraction | null,
  activeWorkScheduleId?: string,
) =>
  createStore<TestStore>((set, get, api) => ({
    ...createPlaybackSlice(set as never, get as never, api as never),
    scheduleRange: range,
    scheduleData,
    activeWorkScheduleId,
  }));

const DAY = 86_400_000;

// Deliberately not imported from `work-calendar.ts` (kept import-free of the
// production module under test here, see the file-header note on
// `check-test-revert-oracle`): builds a LOCAL midnight directly, matching
// `work-calendar.ts`'s `localDayStart` basis (itself matching
// `schedule-utils.ts`'s `computeTicks`) — NOT UTC, so calendar weekday
// matching (`isWorkingDay`'s `getDay()`) lines up regardless of the
// runner's timezone offset sign.
function d(iso: string): number {
  const [y, m, day] = iso.split('-').map(Number);
  return new Date(y, m - 1, day).getTime();
}

/** Mon-Fri weekly calendar, same shape as `work-calendar.test.ts` (#4830). */
const MON_FRI_CALENDAR: WorkCalendarInfo = {
  expressId: 64,
  globalId: 'cal-gid',
  name: 'Site calendar',
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

function scheduleWithCalendar(): ScheduleExtraction {
  return {
    hasSchedule: true,
    workCalendars: [MON_FRI_CALENDAR],
    workSchedules: [],
    tasks: [],
    sequences: [],
  };
}

describe('playbackSlice', () => {
  it('advancePlaybackBy does nothing when not playing', () => {
    const s = makeStore({ start: 0, end: 100 * DAY, synthetic: false });
    s.getState().advancePlaybackBy(16);
    assert.strictEqual(s.getState().playbackTime, 0);
  });

  it('advancePlaybackBy does nothing when there is no schedule range', () => {
    const s = makeStore(null);
    s.getState().playSchedule();
    s.getState().advancePlaybackBy(16);
    assert.strictEqual(s.getState().playbackTime, 0);
  });

  it('advances playbackTime by speed * elapsed real time', () => {
    const s = makeStore({ start: 0, end: 1000 * DAY, synthetic: false });
    s.getState().setPlaybackSpeed(7); // 7 simulated days / real second
    s.getState().playSchedule();
    // 16ms real time * 7 days/sec * 86_400_000 ms/day / 1000 = 9,676,800 ms simulated
    s.getState().advancePlaybackBy(16);
    const expected = 16 * 7 * 86_400;
    assert.strictEqual(s.getState().playbackTime, expected);
  });

  it('clamps a large rAF delta (tab-hidden / breakpoint gap) to 100ms before scaling', () => {
    const s = makeStore({ start: 0, end: 100_000 * DAY, synthetic: false });
    s.getState().setPlaybackSpeed(7);
    s.getState().playSchedule();
    // A 5-second gap (tab was backgrounded) must be clamped to 100ms of
    // simulated advance, not scaled as if it were a real 5s frame - otherwise
    // one dropped frame skips weeks of schedule.
    s.getState().advancePlaybackBy(5000);
    const clampedExpected = 100 * 7 * 86_400;
    assert.strictEqual(s.getState().playbackTime, clampedExpected);
  });

  it('ignores a negative delta rather than rewinding', () => {
    const s = makeStore({ start: 0, end: 100 * DAY, synthetic: false });
    s.getState().setPlaybackSpeed(7);
    s.getState().playSchedule();
    s.getState().advancePlaybackBy(-1000);
    assert.strictEqual(s.getState().playbackTime, 0);
  });

  it('loops back to range start when playbackLoop is true and time overshoots the end', () => {
    const start = 0;
    const end = 5 * DAY;
    const s = makeStore({ start, end, synthetic: false });
    s.getState().setPlaybackSpeed(7);
    s.getState().setPlaybackLoop(true);
    s.getState().seekSchedule(end - 1); // 1ms from the end
    s.getState().playSchedule();
    s.getState().advancePlaybackBy(16); // far more than 1ms of simulated time
    assert.strictEqual(s.getState().playbackTime, start);
    assert.strictEqual(s.getState().playbackIsPlaying, true);
  });

  it('stops exactly at range end and pauses when playbackLoop is false', () => {
    const start = 0;
    const end = 5 * DAY;
    const s = makeStore({ start, end, synthetic: false });
    s.getState().setPlaybackSpeed(7);
    s.getState().setPlaybackLoop(false);
    s.getState().seekSchedule(end - 1);
    s.getState().playSchedule();
    s.getState().advancePlaybackBy(16);
    assert.strictEqual(s.getState().playbackTime, end);
    assert.strictEqual(s.getState().playbackIsPlaying, false);
  });

  it('togglePlaySchedule turns on animationEnabled but leaves it alone on pause', () => {
    const s = makeStore(null);
    assert.strictEqual(s.getState().animationEnabled, false);
    s.getState().togglePlaySchedule();
    assert.strictEqual(s.getState().playbackIsPlaying, true);
    assert.strictEqual(s.getState().animationEnabled, true);
    s.getState().togglePlaySchedule();
    assert.strictEqual(s.getState().playbackIsPlaying, false);
    // Pausing must not turn animation off - a paused-but-still-enabled
    // playback keeps the 4D-colored view rendered, it just stops advancing.
    assert.strictEqual(s.getState().animationEnabled, true);
  });

  it('patchAnimationSettings shallow-merges without clobbering unrelated fields', () => {
    const s = makeStore(null);
    const before = s.getState().animationSettings;
    s.getState().patchAnimationSettings({ colorizeByTaskType: true, paletteIntensity: 0.6 });
    const after = s.getState().animationSettings;
    assert.strictEqual(after.colorizeByTaskType, true);
    assert.strictEqual(after.paletteIntensity, 0.6);
    // Every other field from the default carries through untouched.
    for (const key of Object.keys(before) as (keyof typeof before)[]) {
      if (key === 'colorizeByTaskType' || key === 'paletteIntensity') continue;
      assert.deepStrictEqual(after[key], before[key]);
    }
  });

  describe('respectWorkCalendar (#4830)', () => {
    it('defaults to true and can be toggled', () => {
      const s = makeStore(null);
      assert.strictEqual(s.getState().respectWorkCalendar, true);
      s.getState().setRespectWorkCalendar(false);
      assert.strictEqual(s.getState().respectWorkCalendar, false);
    });

    // A max-clamped (100ms) tick at 7 days/sec simulates 16.8h
    // (100 * 7 * 86_400 ms) — enough to carry Friday noon into early
    // Saturday, but never far enough to reach Monday on its own. Any
    // Monday landing therefore proves the calendar skip fired, not that
    // the raw simulated-time step happened to land there.
    const FRIDAY_NOON = d('2024-06-07') + 12 * 3_600_000;
    const RAW_TICK_SIMULATED_MS = 100 * 7 * 86_400;

    it('skips a landing instant inside a non-working day forward to the next working day', () => {
      const start = d('2024-06-03'); // Monday
      const end = d('2024-06-14'); // next Friday
      const s = makeStore({ start, end, synthetic: false }, scheduleWithCalendar());
      s.getState().setPlaybackSpeed(7);
      s.getState().setPlaybackLoop(false);
      s.getState().seekSchedule(FRIDAY_NOON);
      s.getState().playSchedule();
      s.getState().advancePlaybackBy(1000); // clamped to 100ms -> lands ~Sat 04:48
      assert.strictEqual(s.getState().playbackTime, d('2024-06-10')); // Monday
    });

    it('does not skip when respectWorkCalendar is off', () => {
      const start = d('2024-06-03');
      const end = d('2024-06-14');
      const s = makeStore({ start, end, synthetic: false }, scheduleWithCalendar());
      s.getState().setRespectWorkCalendar(false);
      s.getState().setPlaybackSpeed(7);
      s.getState().setPlaybackLoop(false);
      s.getState().seekSchedule(FRIDAY_NOON);
      s.getState().playSchedule();
      s.getState().advancePlaybackBy(1000);
      const expected = FRIDAY_NOON + RAW_TICK_SIMULATED_MS;
      assert.strictEqual(s.getState().playbackTime, expected);
      // Sanity: the un-skipped landing really is inside the weekend, so
      // the skip in the previous test is doing real work, not a no-op.
      assert.ok(expected > d('2024-06-08') && expected < d('2024-06-10'));
    });

    it('has no effect when the file has no calendars', () => {
      const start = d('2024-06-03');
      const end = d('2024-06-14');
      const s = makeStore({ start, end, synthetic: false }, {
        hasSchedule: false, workCalendars: [], workSchedules: [], tasks: [], sequences: [],
      });
      s.getState().setPlaybackSpeed(7);
      s.getState().setPlaybackLoop(false);
      s.getState().seekSchedule(FRIDAY_NOON);
      s.getState().playSchedule();
      s.getState().advancePlaybackBy(1000);
      assert.strictEqual(s.getState().playbackTime, FRIDAY_NOON + RAW_TICK_SIMULATED_MS);
    });

    it('loop-wraps to a working day when scheduleRange.start itself is non-working (#4982 review)', () => {
      const start = d('2024-06-08'); // Saturday — non-working under MON_FRI_CALENDAR
      const end = d('2024-06-14'); // Friday
      const s = makeStore({ start, end, synthetic: false }, scheduleWithCalendar());
      s.getState().setPlaybackSpeed(7);
      s.getState().setPlaybackLoop(true);
      s.getState().seekSchedule(end - 1); // 1ms from the end, next tick overshoots
      s.getState().playSchedule();
      s.getState().advancePlaybackBy(16);
      // An earlier revision landed directly on `scheduleRange.start` here
      // (the non-working Saturday) and relied on the NEXT tick to notice —
      // the wrapped landing itself must already be a working day.
      assert.strictEqual(s.getState().playbackTime, d('2024-06-10')); // Monday
      assert.strictEqual(s.getState().playbackIsPlaying, true);
    });

    it('stops playback at range start, without hanging, when no working day exists anywhere in range (#4982 review)', () => {
      const totalShutdown: WorkCalendarInfo = {
        ...MON_FRI_CALENDAR,
        exceptionTimes: [{ name: 'Everything shut', start: '2024-06-01', finish: '2024-06-30' }],
      };
      const data: ScheduleExtraction = {
        hasSchedule: true, workCalendars: [totalShutdown], workSchedules: [], tasks: [], sequences: [],
      };
      const start = d('2024-06-03');
      const end = d('2024-06-14');
      const s = makeStore({ start, end, synthetic: false }, data);
      s.getState().setPlaybackSpeed(7);
      s.getState().setPlaybackLoop(true);
      s.getState().seekSchedule(end - 1);
      s.getState().playSchedule();
      s.getState().advancePlaybackBy(16);
      assert.strictEqual(s.getState().playbackTime, start);
      // An earlier revision left `playbackIsPlaying: true` here, which with
      // `playbackLoop` true re-ran this exact same dead-end search on every
      // rAF tick forever — there is nothing to animate, so playback must
      // actually stop.
      assert.strictEqual(s.getState().playbackIsPlaying, false);
      // Confirm it really is a stop, not a one-frame fluke: a further tick
      // does nothing (advancePlaybackBy no-ops while `playbackIsPlaying` is
      // false).
      s.getState().advancePlaybackBy(16);
      assert.strictEqual(s.getState().playbackTime, start);
    });
  });
});
