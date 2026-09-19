/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Playback state slice — drives the 4D / Gantt animation clock.
 *
 * Owns:
 *   • the animation master toggle + play-state + cursor time
 *   • playback rate + loop setting
 *   • `animationSettings` (palette, style flags, ghosting, tinting)
 *
 * Extracted from the schedule slice so its ~70-lines worth of state +
 * mutators don't crowd the schedule-domain logic. Reads
 * `scheduleRange` from `scheduleSlice` via the combined store shape
 * in `advancePlaybackBy`, but every other mutator is self-contained —
 * so this slice can safely be subscribed-to in isolation by the
 * render-tick rAF loop without pulling the full schedule data into
 * a Zustand shallow-compare.
 */

import type { StateCreator } from 'zustand';
import type { AnimationSettings } from '@/components/viewer/schedule/schedule-animator';
import { DEFAULT_ANIMATION_SETTINGS } from '@/components/viewer/schedule/schedule-animator';
import { resolveActiveCalendar, skipToNextWorkingInstant } from '@/components/viewer/schedule/work-calendar';
import type { ScheduleExtraction } from '@ifc-lite/parser';
import type { ScheduleTimeRange } from './scheduleSlice.js';
import { defineSliceTeardown, notApplicable } from '../teardown.js';

export interface PlaybackSlice {
  /** Animation master toggle — when false the viewer renders normally. */
  animationEnabled: boolean;
  /** Is the playback currently advancing? */
  playbackIsPlaying: boolean;
  /** Current playback time, epoch ms. */
  playbackTime: number;
  /** Playback rate in simulated-days-per-real-second. */
  playbackSpeed: number;
  /** When true, looping from end → start. */
  playbackLoop: boolean;
  /**
   * Animation style + palette settings. See `schedule-animator.ts` for the
   * phase / colour model. `minimal` keeps the original visibility-only
   * behaviour; `phased` lights up the type-colour lifecycle.
   */
  animationSettings: AnimationSettings;
  /**
   * When true (default) AND the active schedule assigns an `IfcWorkCalendar`
   * (see `resolveActiveCalendar`), auto-play jumps forward over non-working
   * days instead of animating through them — #4830. Off keeps the previous
   * behaviour: the clock advances uniformly regardless of any calendar.
   * A separate flag from `animationSettings` on purpose: it's a playback
   * *pacing* concern, not a colour/visibility one, and `AnimationSettings`
   * lives in `schedule-animator.ts`, which is already at this repo's
   * module-size ratchet ceiling.
   */
  respectWorkCalendar: boolean;

  setAnimationEnabled: (enabled: boolean) => void;
  /** Replace the full animation-settings object. */
  setAnimationSettings: (settings: AnimationSettings) => void;
  /** Shallow-merge patch — convenient for toolbar toggles. */
  patchAnimationSettings: (patch: Partial<AnimationSettings>) => void;
  /** Restore the built-in Synchro-style defaults. */
  resetAnimationSettings: () => void;
  playSchedule: () => void;
  pauseSchedule: () => void;
  togglePlaySchedule: () => void;
  seekSchedule: (time: number) => void;
  setPlaybackSpeed: (speed: number) => void;
  setPlaybackLoop: (loop: boolean) => void;
  setRespectWorkCalendar: (respect: boolean) => void;
  advancePlaybackBy: (deltaMs: number) => void;
}

/**
 * Cross-slice reads needed by the playback slice — the rAF advance
 * loop clamps against the current `scheduleRange.end`. Declared
 * explicitly rather than as a cast so the combined store keeps this
 * field accessible at compile time too.
 */
interface PlaybackCrossSliceReads {
  scheduleRange?: ScheduleTimeRange | null;
  scheduleData?: ScheduleExtraction | null;
  activeWorkScheduleId?: string;
}

export const createPlaybackSlice: StateCreator<
  PlaybackSlice & PlaybackCrossSliceReads,
  [],
  [],
  PlaybackSlice
> = (set, get) => ({
  animationEnabled: false,
  playbackIsPlaying: false,
  playbackTime: 0,
  playbackSpeed: 7, // 7 simulated days per real second by default
  playbackLoop: true,
  animationSettings: DEFAULT_ANIMATION_SETTINGS,
  respectWorkCalendar: true,

  setAnimationEnabled: (animationEnabled) => set({ animationEnabled }),
  setAnimationSettings: (animationSettings) => set({ animationSettings }),
  patchAnimationSettings: (patch) => set((s) => ({
    animationSettings: { ...s.animationSettings, ...patch },
  })),
  resetAnimationSettings: () => set({ animationSettings: DEFAULT_ANIMATION_SETTINGS }),
  playSchedule: () => set({ playbackIsPlaying: true, animationEnabled: true }),
  pauseSchedule: () => set({ playbackIsPlaying: false }),
  togglePlaySchedule: () => set((s) => {
    const next = !s.playbackIsPlaying;
    return {
      playbackIsPlaying: next,
      animationEnabled: next ? true : s.animationEnabled,
    };
  }),
  seekSchedule: (time) => set({ playbackTime: time }),
  setPlaybackSpeed: (playbackSpeed) => set({ playbackSpeed }),
  setPlaybackLoop: (playbackLoop) => set({ playbackLoop }),
  setRespectWorkCalendar: (respectWorkCalendar) => set({ respectWorkCalendar }),

  advancePlaybackBy: (deltaMs) => {
    const s = get();
    if (!s.playbackIsPlaying || !s.scheduleRange) return;
    // Clamp the wall-clock delta before scaling. rAF pauses when the tab is
    // hidden, OS sleeps, or a breakpoint fires; the next frame fires with a
    // multi-second delta. At the default 7 days/sec that would skip weeks of
    // schedule in one step, either missing animation states or overshooting
    // the end of non-looping playback.
    const MAX_DELTA_MS = 100;
    const clamped = Math.min(Math.max(deltaMs, 0), MAX_DELTA_MS);
    // speed = simulated days / real second
    //   → simulated ms = (deltaMs / 1000) * speed * 86_400_000
    //                  = deltaMs * speed * 86_400
    const simulated = clamped * s.playbackSpeed * 86_400;
    let next = s.playbackTime + simulated;
    if (next > s.scheduleRange.end) {
      if (s.playbackLoop) {
        next = s.scheduleRange.start;
      } else {
        set({ playbackTime: s.scheduleRange.end, playbackIsPlaying: false });
        return;
      }
    }
    // Synthetic ranges (`ScheduleTimeRange.synthetic`, `scheduleSlice.ts`)
    // are day-0-relative placeholders for schedules with no real dates
    // (day 0 .. sum-of-durations) — NOT calendar dates. A real
    // `IfcWorkCalendar`'s WEEKLY pattern and start/finish bounds are
    // written against real years, so evaluating one against 1970-epoch
    // instants makes every entry's `withinBounds` check fail: every
    // simulated day reads as non-working and playback stops dead (#4982
    // review). Calendar-aware skipping only makes sense once the schedule
    // has a real calendar basis.
    if (s.respectWorkCalendar && !s.scheduleRange.synthetic) {
      const calendar = resolveActiveCalendar(s.scheduleData, s.activeWorkScheduleId);
      if (calendar) {
        // Bound the search at the range end — `skipToNextWorkingInstant`
        // returns `null` rather than `next` unchanged when nothing working
        // remains before that bound (e.g. a shutdown running to the very
        // end of the schedule), so "ran out of working days" and "ran out
        // of range" are handled identically below rather than the caller
        // mistaking a stale `next` for an already-working instant.
        const skipped = skipToNextWorkingInstant(calendar, next, s.scheduleRange.end);
        if (skipped === null) {
          if (s.playbackLoop) {
            // Loop back to the start — but the start itself can open on a
            // non-working day (a schedule that begins mid-shutdown), so
            // resolve THAT too rather than landing playback on a
            // non-working instant until the next tick fixes it (#4982
            // review). Search the whole range again: the wrap is a fresh
            // start, not a continuation of the forward search that just
            // ran out.
            const loopedStart = skipToNextWorkingInstant(calendar, s.scheduleRange.start, s.scheduleRange.end);
            if (loopedStart === null) {
              // The calendar has no working day ANYWHERE in the range —
              // there is nothing to animate. Stop rather than landing on
              // `scheduleRange.start` still "playing": with `playbackLoop`
              // true that would re-run this exact same two-search dead end
              // on every rAF tick forever (#4982 review). Position lands at
              // the range start (the natural loop target), matching the
              // non-looping branch's symmetric pause-at-range-end below.
              set({ playbackTime: s.scheduleRange.start, playbackIsPlaying: false });
              return;
            }
            next = loopedStart;
          } else {
            set({ playbackTime: s.scheduleRange.end, playbackIsPlaying: false });
            return;
          }
        } else {
          next = skipped;
        }
      }
    }
    set({ playbackTime: next });
  },
});

/**
 * Schedule (4D) playback — stop the clock and rewind it on a file swap.
 *
 * `playbackSpeed`, `playbackLoop` and `animationSettings` are deliberately
 * ABSENT from both `owns` and the body: they are user preferences that survive
 * file loads, exactly as `resetViewerState`'s schedule block says.
 */
export const playbackTeardown = defineSliceTeardown(
  'playbackSlice',
  ['animationEnabled', 'playbackIsPlaying', 'playbackTime'],
  {
    'session-reset': () => ({
      animationEnabled: false,
      playbackIsPlaying: false,
      playbackTime: 0,
    }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
