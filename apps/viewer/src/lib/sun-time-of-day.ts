/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Manual "time of day" sun position for models WITHOUT georeference (#2670).
 *
 * The real solar study needs a site (lat/lon from IfcMapConversion) to place
 * the sun. A plain model has none, so this drives the sun along a simple,
 * plausible east→west arc from a single time-of-day slider: it rises in the
 * east, climbs to a southern peak at noon, and sets in the west. It is NOT an
 * astronomical fit — for a georeferenced model the study wins — but it lets a
 * user sweep shadows across any model.
 *
 * Output is a unit direction TOWARD the sun in viewer/world space (Y-up),
 * matching `LightingEnvironment.sunDirection`, plus the altitude in degrees so
 * the caller can warm/dim the light near the horizon exactly as the real study
 * does.
 */

/** Day window the slider spans, in hours. */
export const SUN_DAY_START = 6;
export const SUN_DAY_END = 18;
/** Peak altitude at solar noon, degrees. */
const MAX_ALTITUDE_DEG = 68;
/** Floor so dawn/dusk shadows stay finite rather than infinitely long. */
const MIN_ALTITUDE_DEG = 6;

export interface SunTimeResult {
  /** Unit vector toward the sun, viewer space (Y-up). */
  sunDirection: [number, number, number];
  /** Sun altitude above the horizon, degrees (>= MIN_ALTITUDE_DEG). */
  altitudeDeg: number;
}

/**
 * Sun direction for a time of day (hours, 24h). Clamped to the day window;
 * values outside it resolve to the nearest horizon.
 */
export function sunDirectionForTimeOfDay(hours: number): SunTimeResult {
  const h = Number.isFinite(hours) ? hours : 12;
  const clamped = Math.min(SUN_DAY_END, Math.max(SUN_DAY_START, h));
  // f: 0 at sunrise (east) → 0.5 at noon (south, highest) → 1 at sunset (west).
  const f = (clamped - SUN_DAY_START) / (SUN_DAY_END - SUN_DAY_START);
  const altitudeDeg = Math.max(MIN_ALTITUDE_DEG, MAX_ALTITUDE_DEG * Math.sin(Math.PI * f));
  const el = (altitudeDeg * Math.PI) / 180;
  // a: 0 (east, +X) → π (west, −X); the noon lean is toward −Z ("south").
  const a = Math.PI * f;
  const cosEl = Math.cos(el);
  const sunDirection: [number, number, number] = [
    cosEl * Math.cos(a),
    Math.sin(el),
    -cosEl * Math.sin(a),
  ];
  return { sunDirection, altitudeDeg };
}

/** Format a fractional hour as HH:MM for the slider readout. */
export function formatHourOfDay(hours: number): string {
  // Normalize to a whole minute FIRST so a value that rounds to 60 minutes rolls
  // into the next hour (12.999 → 13:00, not 12:59) instead of clamping. Clamp to
  // the displayable day and treat non-finite input as 00:00.
  const bounded = Number.isFinite(hours) ? Math.min(24, Math.max(0, hours)) : 0;
  const totalMinutes = Math.min(24 * 60 - 1, Math.round(bounded * 60));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
