/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The fly speed level, shared between the controller that spends it
 * (`flyControls.ts`) and the readout that shows it
 * (`FlySpeedIndicator.tsx`), and remembered across sessions.
 *
 * A module-level store rather than viewer store state: it changes on every
 * wheel notch during a gesture, nothing outside these two files reads it, and
 * it is a per-browser preference rather than part of the model view.
 */

import { clampFlySpeedLevel, DEFAULT_FLY_SPEED_LEVEL } from './flyNavigation.js';

const SPEED_STORAGE_KEY = 'ifc-lite:fly-speed-level';

export interface FlySpeedState {
  /** Index into `FLY_SPEED_LEVELS`. */
  level: number;
  /** True while the right button is held and fly mode is live. */
  active: boolean;
  /** `performance.now()` of the last level change, for the transient readout. */
  changedAt: number;
}

/**
 * Storage throws in a private window or with site data blocked, and returns
 * whatever a previous version (or a user) put there, so a bad value falls back
 * to the default rather than poisoning the speed.
 */
function readStoredLevel(): number {
  try {
    const raw = localStorage.getItem(SPEED_STORAGE_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) ? clampFlySpeedLevel(n) : DEFAULT_FLY_SPEED_LEVEL;
  } catch (error) {
    console.warn('[flySpeedStore] Could not read stored fly speed:', error);
    return DEFAULT_FLY_SPEED_LEVEL;
  }
}

let state: FlySpeedState = { level: readStoredLevel(), active: false, changedAt: -Infinity };
const listeners = new Set<() => void>();

/** Internal: the controller's own updates (activity), which are not persisted. */
export function setFlySpeedState(patch: Partial<FlySpeedState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export const flySpeedStore = {
  get: (): FlySpeedState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  setLevel(level: number): void {
    const next = clampFlySpeedLevel(level);
    if (next === state.level) return;
    setFlySpeedState({ level: next, changedAt: performance.now() });
    try {
      localStorage.setItem(SPEED_STORAGE_KEY, String(next));
    } catch (error) {
      console.warn('[flySpeedStore] Could not store fly speed:', error);
    }
  },
};
