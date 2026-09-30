/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The dimensions the Stair and Railing commands build with (charter #6232,
 * D1), typed in their bars and kept from one placement to the next. They are
 * plain module state, not part of a gesture: Escape resets a run, but the
 * width someone typed stays. `RiserTarget` is the riser height the flight is
 * fitted to; the built riser is the storey's rise divided by the whole number
 * of risers nearest it, so the flight always ends exactly on the storey above.
 */

export interface StairSettings {
  /** Clear width across the run, metres. */
  readonly Width: number;
  /** The riser height the flight is fitted to, metres. */
  readonly RiserTarget: number;
  /** Waist thickness perpendicular to the pitch, metres. */
  readonly Waist: number;
}

export interface RailingSettings {
  /** Top of the handrail above the path, metres. */
  readonly Height: number;
  /** Largest distance between posts, metres. */
  readonly PostSpacing: number;
}

export const STAIR_DEFAULTS: StairSettings = { Width: 1, RiserTarget: 0.175, Waist: 0.15 };
export const RAILING_DEFAULTS: RailingSettings = { Height: 1, PostSpacing: 1.2 };

let stair = STAIR_DEFAULTS;
let railing = RAILING_DEFAULTS;

export const stairSettings = (): StairSettings => stair;
export const railingSettings = (): RailingSettings => railing;

export function setStairSettings(patch: Partial<StairSettings>): void {
  stair = { ...stair, ...patch };
}

export function setRailingSettings(patch: Partial<RailingSettings>): void {
  railing = { ...railing, ...patch };
}

/** Back to the built-in dimensions (tests). */
export function resetStairRailingSettings(): void {
  stair = STAIR_DEFAULTS;
  railing = RAILING_DEFAULTS;
}
