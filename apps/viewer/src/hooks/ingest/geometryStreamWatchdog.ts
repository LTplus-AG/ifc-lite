/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The loader's geometry stream watchdog: one iterator pull raced against a
 * silence window (`getGeometryStreamWatchdogMs`), failing the load with
 * "Geometry stream stalled after Nms" when the pool says nothing at all.
 *
 * The window measures wall-clock time, which is only evidence while the page
 * runs. When the browser freezes the tab (background-tab freezing, an
 * efficiency or energy-saver mode, the machine sleeping) its dedicated workers
 * stop with it, so nothing is posted, and the overdue timer runs as soon as the
 * page resumes, before a resumed worker can post its next heartbeat. The pool's
 * own hung-call monitor already discounts such a gap
 * (`SUSPEND_GAP_INTERVALS` in `@ifc-lite/geometry`'s hung-job-recovery); this
 * watchdog did not. A timer that fires more than {@link SUSPEND_LATENESS_MS}
 * after its deadline therefore re-arms a full window instead of failing: the
 * pool gets a window of RUNNING time to speak. The window is not lengthened
 * while the page runs, so a hung pool on a visible tab still fails on time.
 */

import type { StallPhaseHandle } from '@ifc-lite/geometry';
import { geometryProcessingStallPhase } from '../modelLoadedGeometryProps.js';

/** A watchdog timer this late did not run on time: the page was suspended or
 *  its main thread blocked, so the elapsed window measured no pool silence.
 *  Far above the 1 s alignment browsers apply to timers in hidden tabs. */
export const SUSPEND_LATENESS_MS = 5_000;

/** Per-load watchdog record, read by the failure capture. */
export interface StreamWatchdogState {
  /** Windows re-armed because their timer fired late (suspended page). */
  suspendedRearms: number;
  /** Set when the watchdog failed the load. */
  stall?: {
    /** How late the failing timer fired, in ms (0 when on time). */
    lateMs: number;
    /** `document.visibilityState === 'hidden'` when it fired. */
    hidden: boolean;
  };
}

/** Timer seam: the real globals in production, a fake clock in tests. */
export interface WatchdogClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  isHidden(): boolean;
}

const BROWSER_CLOCK: WatchdogClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
};

export function createStreamWatchdogState(): StreamWatchdogState {
  return { suspendedRearms: 0 };
}

/**
 * Resolve with `next`, or reject with the stall error once the pool has been
 * silent for `watchdogMs` of running time. The timer is always cleared when
 * `next` settles first, including on rejection.
 */
export function pullWithStallWatchdog<T>(
  next: Promise<T>,
  watchdogMs: number,
  lastTotalMeshes: number,
  state: StreamWatchdogState,
  clock: WatchdogClock = BROWSER_CLOCK,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: unknown;
    const arm = () => {
      const armedAt = clock.now();
      timer = clock.setTimeout(() => {
        if (settled) return;
        const lateMs = clock.now() - armedAt - watchdogMs;
        if (lateMs > SUSPEND_LATENESS_MS) {
          state.suspendedRearms++;
          console.warn(`[useIfc] geometry watchdog fired ${Math.round(lateMs)}ms late (page suspended); re-arming ${watchdogMs}ms`);
          arm();
          return;
        }
        settled = true;
        state.stall = { lateMs: Math.max(0, Math.round(lateMs)), hidden: clock.isHidden() };
        // Do NOT embed `file.name` here: this Error is captured by error
        // tracking (and auto-filed as a public GitHub issue), so a confidential
        // model name would leak. The user sees it via formatLoadError(err, file.name).
        reject(new Error(`Geometry stream stalled after ${watchdogMs}ms. Last rendered meshes: ${lastTotalMeshes}.`));
      }, watchdogMs);
    };
    arm();
    next.then(
      (value) => {
        if (settled) return;
        settled = true;
        clock.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clock.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Properties every `geometry_processing` failure capture carries, on the
 * first attempt (the one that triggers the lower-detail retry) and on the
 * terminal one alike. Keys stay clear of `analytics-scrub.ts`'s sensitive
 * words; every value is a number, boolean or a `StallPhase` enum.
 */
export function geometryFailureCaptureProps(input: {
  fileSizeMB: number;
  stallPhaseHandle: StallPhaseHandle;
  watchdog: StreamWatchdogState;
  wasHidden: boolean;
}): Record<string, unknown> {
  const { stall } = input.watchdog;
  return {
    file_size_mb: Math.round(input.fileSizeMB * 100) / 100,
    // #4902: which pre-worker gate the pool was still waiting on, so a
    // "Last rendered meshes: 0" stall is attributed to a measured phase.
    stall_phase: geometryProcessingStallPhase(input.stallPhaseHandle),
    was_hidden: input.wasHidden,
    watchdog_suspended_rearms: input.watchdog.suspendedRearms,
    ...(stall ? { stall_late_ms: stall.lateMs, hidden_at_stall: stall.hidden } : {}),
  };
}
