/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sunrise / sunset / solar-noon times, derived from the same NOAA solar
 * geometry as {@link sunPosition}. Returned as absolute `Date` instants (UTC)
 * so callers can format them in whatever timezone the site uses.
 */

import { solarGeometry, toJulianDay } from './solar-position.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Standard refraction-corrected solar zenith for sunrise/sunset (90° 50′). */
const SUNRISE_ZENITH = 90.833;

export interface SunTimes {
  /** Sunrise instant, or null if the sun never rises that day (polar night). */
  sunrise: Date | null;
  /** Sunset instant, or null if the sun never sets that day (midnight sun). */
  sunset: Date | null;
  /** Solar noon (sun crosses the local meridian). Always defined. */
  solarNoon: Date;
  /** True if the sun is above the horizon for the whole UTC day. */
  alwaysUp: boolean;
  /** True if the sun is below the horizon for the whole UTC day. */
  alwaysDown: boolean;
}

/**
 * Compute sunrise/sunset/solar-noon for the UTC calendar day containing
 * `date`, at the given site.
 *
 * @param date      Any instant within the desired UTC day.
 * @param latitude  Site latitude in degrees (north positive).
 * @param longitude Site longitude in degrees (east positive).
 */
export function sunTimes(date: Date, latitude: number, longitude: number): SunTimes {
  // Anchor to solar geometry at local solar noon for best accuracy.
  const noonProbe = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12, 0, 0),
  );
  const { declination, equationOfTime } = solarGeometry(noonProbe);

  // Solar noon (UTC minutes from midnight): meridian transit corrected for
  // longitude and the equation of time.
  const solarNoonMinutes = 720 - 4 * longitude - equationOfTime;
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const solarNoon = new Date(dayStart + solarNoonMinutes * 60_000);

  const latRad = latitude * DEG;
  const decRad = declination * DEG;

  // Exact poles: cos(latitude) = 0 makes the hour-angle formula divide by zero
  // (cosHa = NaN), which would skip both polar branches and yield Invalid Date.
  // At a pole the sun holds a near-constant altitude ≈ declination all day, so
  // decide always-up vs always-down directly from that altitude.
  if (Math.abs(Math.cos(latRad)) < 1e-12) {
    const poleAltitude = latitude > 0 ? declination : -declination;
    const alwaysUp = poleAltitude >= -(SUNRISE_ZENITH - 90);
    return { sunrise: null, sunset: null, solarNoon, alwaysUp, alwaysDown: !alwaysUp };
  }

  const cosHa =
    Math.cos(SUNRISE_ZENITH * DEG) / (Math.cos(latRad) * Math.cos(decRad)) -
    Math.tan(latRad) * Math.tan(decRad);

  if (cosHa < -1) {
    // Sun never sets this day.
    return { sunrise: null, sunset: null, solarNoon, alwaysUp: true, alwaysDown: false };
  }
  if (cosHa > 1) {
    // Sun never rises this day.
    return { sunrise: null, sunset: null, solarNoon, alwaysUp: false, alwaysDown: true };
  }

  const haMinutes = (Math.acos(cosHa) * RAD) * 4; // 4 minutes per degree
  return {
    sunrise: new Date(solarNoon.getTime() - haMinutes * 60_000),
    sunset: new Date(solarNoon.getTime() + haMinutes * 60_000),
    solarNoon,
    alwaysUp: false,
    alwaysDown: false,
  };
}
