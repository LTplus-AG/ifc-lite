/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measure Point mode's state (#8770), composed into the measurement slice.
 *
 * The snapped point under the cursor, and the point the last click placed.
 * Transient on purpose: a coordinate reading is not a measurement, so neither
 * is listed, counted or exported. Only ever non-null in Point mode: the
 * setters refuse writes from any other mode, and the measurement slice clears
 * both when Point mode is left (`setMeasureMode`) and on its resets.
 */

import type { MeasureMode, MeasurePoint } from '../types.js';

export interface MeasurePointSlice {
  measurePointLive: MeasurePoint | null;
  measurePointLast: MeasurePoint | null;
  /** Set or clear the live hover point. No-op outside Point mode. */
  setMeasurePointLive: (point: MeasurePoint | null) => void;
  /** Commit a clicked point as the last point. No-op outside Point mode. */
  placeMeasurePoint: (point: MeasurePoint) => void;
  /** Drop both the live and the last point (Esc). */
  clearMeasurePoint: () => void;
}

/** Both points cleared: spread into every reset that drops measure state. */
export const NO_MEASURE_POINT = { measurePointLive: null, measurePointLast: null } as const;

type Set = (fn: (state: MeasurePointSlice & { measureMode: MeasureMode }) => Partial<MeasurePointSlice>) => void;

export function createMeasurePointSlice(set: Set): MeasurePointSlice {
  return {
    ...NO_MEASURE_POINT,
    setMeasurePointLive: (point) => set((state) =>
      state.measureMode === 'point' || point === null ? { measurePointLive: point } : {}),
    // Dropping the preview makes the readout flip to "Last point" on the
    // click itself; the next hover frame brings the preview back.
    placeMeasurePoint: (point) => set((state) =>
      state.measureMode === 'point' ? { measurePointLast: point, measurePointLive: null } : {}),
    clearMeasurePoint: () => set(() => NO_MEASURE_POINT),
  };
}
