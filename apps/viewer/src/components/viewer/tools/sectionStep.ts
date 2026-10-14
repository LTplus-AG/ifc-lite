/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The offset step (#7545): how far one wheel notch, one arrow key or one
 * stepper click moves the active plane. A per-user preference held in metres,
 * like everything the store holds, so it means the same on every model; the
 * field converts it to the project unit when it needs a number.
 */

import { create } from 'zustand';

const STORAGE_KEY = 'ifc-lite:section-step';

export const DEFAULT_SECTION_STEP_M = 0.1;
/** What the step menu offers, in metres: 1 cm, 5 cm, 10 cm, 25 cm, 50 cm, 1 m. */
export const SECTION_STEP_PRESETS_M: readonly number[] = [0.01, 0.05, 0.1, 0.25, 0.5, 1];
/** Bounds a custom step to something a plane can usefully move by: 0.1 mm to 100 m. */
export const MIN_SECTION_STEP_M = 0.0001;
export const MAX_SECTION_STEP_M = 100;

function isUsable(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= MIN_SECTION_STEP_M && n <= MAX_SECTION_STEP_M;
}

function load(): number {
  if (typeof window === 'undefined') return DEFAULT_SECTION_STEP_M;
  try {
    const parsed = Number(window.localStorage.getItem(STORAGE_KEY));
    return isUsable(parsed) ? parsed : DEFAULT_SECTION_STEP_M;
  } catch (error) {
    console.warn('[section] failed to load the offset step', error);
    return DEFAULT_SECTION_STEP_M;
  }
}

interface SectionStepState {
  stepM: number;
  /** Set the step in metres; an unusable value is ignored. */
  setStepM: (stepM: number) => void;
}

export const useSectionStep = create<SectionStepState>()((set) => ({
  stepM: load(),
  setStepM: (stepM) => {
    if (!isUsable(stepM)) return;
    set({ stepM });
    try {
      window.localStorage.setItem(STORAGE_KEY, String(stepM));
    } catch (error) {
      console.warn('[section] failed to save the offset step', error);
    }
  },
}));

/** `10 cm`, `7 mm`, `1 m`: a step in the units people say it in, whatever the project unit. */
export function formatStep(stepM: number): string {
  const trim = (n: number) => String(Number(n.toFixed(2)));
  if (stepM < 0.01 - 1e-12) return `${trim(stepM * 1000)} mm`;
  if (stepM < 1 - 1e-12) return `${trim(stepM * 100)} cm`;
  return `${trim(stepM)} m`;
}
