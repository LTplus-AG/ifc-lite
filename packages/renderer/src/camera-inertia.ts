/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Inertia that runs on elapsed time instead of frames. `CameraAnimator` spends
 * each inertia channel, then multiplies it by `damping`, once per tick, so
 * counting frames would make a slow frame coast further and a 120 Hz display
 * stop sooner. These steps reproduce one tick per 60 Hz frame for any tick
 * length, so the coast is the same at every frame rate and unchanged at 60 Hz.
 */

/** The tick length the inertia constants were tuned at: one 60 Hz frame. */
export const INERTIA_REFERENCE_FRAME_MS = 1000 / 60;

/**
 * Longest tick spent at once. A frame after a stall (a hidden tab, a long GC)
 * would otherwise spend the rest of the coast in one jump.
 */
export const MAX_INERTIA_TICK_MS = 100;

export interface InertiaStep {
  /** Multiplier for the per-frame travel, summed over the tick's frames. */
  travel: number;
  /** Factor the velocity decays by over the tick. */
  decay: number;
}

/**
 * The travel and decay for a tick of `deltaTimeMs`. A non-finite or
 * non-positive tick counts as one 60 Hz frame, so a caller that passes no
 * elapsed time keeps the per-frame behaviour.
 */
export function inertiaStep(deltaTimeMs: number, damping: number): InertiaStep {
  const ms = Number.isFinite(deltaTimeMs) && deltaTimeMs > 0
    ? Math.min(deltaTimeMs, MAX_INERTIA_TICK_MS)
    : INERTIA_REFERENCE_FRAME_MS;
  const frames = ms / INERTIA_REFERENCE_FRAME_MS;
  const decay = damping ** frames;
  // Frames 0..n-1 travel 1, d, d^2, ...: a geometric sum, extended to
  // fractional n. Undamped (d = 1) travels one unit per frame.
  return { travel: damping === 1 ? frames : (1 - decay) / (1 - damping), decay };
}
