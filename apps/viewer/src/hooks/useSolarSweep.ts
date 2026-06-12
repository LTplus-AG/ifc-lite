/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Solar sweep animation — advances the studied instant while playing.
 *
 * Lives at the viewport level (not inside the panel) so collapsing or
 * closing the Sun & Sky panel doesn't stop a running sweep.
 *
 * Reads/writes the store imperatively each tick to avoid stale closures,
 * and wraps within the current day (day sweep) or year (year sweep) so the
 * animation loops cleanly.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import { solarDisplayOffsetMinutes, MS_PER_MIN, MS_PER_DAY } from '@/lib/solar-time';

/** Wall-clock cadence for the animation sweep. */
const TICK_MS = 80;
/** Per-tick advance: 8 minutes of solar time (day) or 2 days (year). */
const DAY_STEP_MIN = 8;
const YEAR_STEP_DAYS = 2;

export function useSolarSweep(): void {
  const enabled = useViewerStore((s) => s.solarEnabled);
  const playing = useViewerStore((s) => s.solarPlaying);
  const sweepMode = useViewerStore((s) => s.solarSweepMode);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (!enabled || !playing) return;
    intervalRef.current = setInterval(() => {
      const store = useViewerStore.getState();
      const current = store.solarDateMs;
      let next: number;
      if (store.solarSweepMode === 'day') {
        // Wrap in the same display frame the slider edits in, so the day seam
        // lands at displayed midnight (not UTC midnight) and the date doesn't
        // flip mid-sweep when site/local time is active.
        const offsetMin = solarDisplayOffsetMinutes(store.solarUseLocalTime, store.solarSunInfo?.longitude);
        const displayMs = current + offsetMin * MS_PER_MIN;
        const disp = new Date(displayMs);
        const dayStart = Date.UTC(disp.getUTCFullYear(), disp.getUTCMonth(), disp.getUTCDate());
        const minutes = (displayMs - dayStart) / MS_PER_MIN;
        const nextMinutes = (minutes + DAY_STEP_MIN) % 1440;
        next = dayStart + nextMinutes * MS_PER_MIN - offsetMin * MS_PER_MIN;
      } else {
        const d = new Date(current);
        const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
        const dayOfYear = Math.floor((current - yearStart) / MS_PER_DAY);
        const isLeap = (d.getUTCFullYear() % 4 === 0 && d.getUTCFullYear() % 100 !== 0) || d.getUTCFullYear() % 400 === 0;
        const daysInYear = isLeap ? 366 : 365;
        const timeOfDay = current - (yearStart + dayOfYear * MS_PER_DAY);
        const nextDay = (dayOfYear + YEAR_STEP_DAYS) % daysInYear;
        next = yearStart + nextDay * MS_PER_DAY + timeOfDay;
      }
      store.setSolarDateMs(next);
    }, TICK_MS);
    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [enabled, playing, sweepMode]);
}
