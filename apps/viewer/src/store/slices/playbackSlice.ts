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
import type { ScheduleTimeRange } from './scheduleSlice.js';

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
    set({ playbackTime: next });
  },
});
