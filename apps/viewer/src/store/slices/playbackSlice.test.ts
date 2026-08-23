/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { createPlaybackSlice, type PlaybackSlice } from './playbackSlice.js';
import type { ScheduleTimeRange } from './scheduleSlice.js';

type TestStore = PlaybackSlice & { scheduleRange: ScheduleTimeRange | null };

const makeStore = (range: ScheduleTimeRange | null) =>
  createStore<TestStore>((set, get, api) => ({
    ...createPlaybackSlice(set as never, get as never, api as never),
    scheduleRange: range,
  }));

const DAY = 86_400_000;

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
});
