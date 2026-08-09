/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { sunPosition, solarGeometry } from './solar-position.js';
import { sunTimes } from './sun-times.js';

// London, on the prime meridian — keeps longitude ≈ 0 so UTC ≈ solar time.
const LAT = 51.4769;
const LON = 0;

describe('solarGeometry', () => {
  it('declination is ~0 at the spring equinox', () => {
    const { declination } = solarGeometry(new Date('2024-03-20T12:00:00Z'));
    expect(Math.abs(declination)).toBeLessThan(1);
  });

  it('declination is ~+23.4 at the summer solstice', () => {
    const { declination } = solarGeometry(new Date('2024-06-20T12:00:00Z'));
    expect(declination).toBeGreaterThan(23);
    expect(declination).toBeLessThan(23.5);
  });

  it('declination is ~-23.4 at the winter solstice', () => {
    const { declination } = solarGeometry(new Date('2024-12-21T12:00:00Z'));
    expect(declination).toBeLessThan(-23);
    expect(declination).toBeGreaterThan(-23.5);
  });
});

describe('sunPosition', () => {
  it('points due south at altitude ≈ (90 − lat) at solar noon on the equinox', () => {
    const noon = sunTimes(new Date('2024-03-20T12:00:00Z'), LAT, LON).solarNoon;
    const { azimuth, altitude } = sunPosition(noon, LAT, LON);
    expect(altitude).toBeCloseTo(90 - LAT, 0); // within ~1°
    expect(azimuth).toBeCloseTo(180, 0);
  });

  it('climbs higher at the summer solstice than the winter solstice', () => {
    const summerNoon = sunTimes(new Date('2024-06-20T12:00:00Z'), LAT, LON).solarNoon;
    const winterNoon = sunTimes(new Date('2024-12-21T12:00:00Z'), LAT, LON).solarNoon;
    const summerAlt = sunPosition(summerNoon, LAT, LON).altitude;
    const winterAlt = sunPosition(winterNoon, LAT, LON).altitude;
    expect(summerAlt).toBeGreaterThan(winterAlt + 40);
    expect(summerAlt).toBeCloseTo(90 - LAT + 23.44, 0);
    expect(winterAlt).toBeCloseTo(90 - LAT - 23.44, 0);
  });

  it('rises in the east and sets in the west', () => {
    const day = '2024-06-20';
    const morning = sunPosition(new Date(`${day}T06:00:00Z`), LAT, LON);
    const evening = sunPosition(new Date(`${day}T19:00:00Z`), LAT, LON);
    // Morning azimuth in the eastern half (0–180), evening in the western half.
    expect(morning.azimuth).toBeGreaterThan(0);
    expect(morning.azimuth).toBeLessThan(180);
    expect(evening.azimuth).toBeGreaterThan(180);
    expect(evening.azimuth).toBeLessThan(360);
  });

  it('is below the horizon at local midnight', () => {
    const midnight = sunPosition(new Date('2024-06-20T00:00:00Z'), LAT, LON);
    expect(midnight.altitude).toBeLessThan(0);
  });

  it('returns finite azimuth/altitude exactly at the poles', () => {
    // cos(latitude) = 0 at ±90°; the acos azimuth form would divide by zero.
    for (const lat of [90, -90]) {
      const p = sunPosition(new Date('2024-06-20T12:00:00Z'), lat, 0);
      expect(Number.isFinite(p.azimuth)).toBe(true);
      expect(Number.isFinite(p.altitude)).toBe(true);
      expect(p.azimuth).toBeGreaterThanOrEqual(0);
      expect(p.azimuth).toBeLessThan(360);
    }
    // North Pole in summer: sun above the horizon at roughly +declination.
    const np = sunPosition(new Date('2024-06-20T12:00:00Z'), 90, 0);
    expect(np.altitude).toBeGreaterThan(0);
  });
});

describe('sunTimes', () => {
  it('gives ~12h of daylight at the equinox', () => {
    const t = sunTimes(new Date('2024-03-20T12:00:00Z'), LAT, LON);
    expect(t.sunrise).not.toBeNull();
    expect(t.sunset).not.toBeNull();
    const hours = (t.sunset!.getTime() - t.sunrise!.getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(12, 0);
  });

  it('gives a long day at the summer solstice', () => {
    const t = sunTimes(new Date('2024-06-20T12:00:00Z'), LAT, LON);
    const hours = (t.sunset!.getTime() - t.sunrise!.getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(16);
  });

  it('detects polar night above the Arctic Circle in winter', () => {
    const t = sunTimes(new Date('2024-12-21T12:00:00Z'), 78, 15);
    expect(t.alwaysDown).toBe(true);
    expect(t.sunrise).toBeNull();
  });

  it('detects the midnight sun above the Arctic Circle in summer', () => {
    const t = sunTimes(new Date('2024-06-20T12:00:00Z'), 78, 15);
    expect(t.alwaysUp).toBe(true);
    expect(t.sunset).toBeNull();
  });

  it('places sunrise before solar noon before sunset', () => {
    const t = sunTimes(new Date('2024-09-15T12:00:00Z'), LAT, LON);
    expect(t.sunrise!.getTime()).toBeLessThan(t.solarNoon.getTime());
    expect(t.solarNoon.getTime()).toBeLessThan(t.sunset!.getTime());
  });

  it('handles exact poles without producing Invalid Date', () => {
    // North Pole, summer → midnight sun; winter → polar night. No NaN/Invalid.
    const npSummer = sunTimes(new Date('2024-06-20T12:00:00Z'), 90, 0);
    expect(npSummer.alwaysUp).toBe(true);
    expect(npSummer.sunrise).toBeNull();
    expect(Number.isFinite(npSummer.solarNoon.getTime())).toBe(true);

    const npWinter = sunTimes(new Date('2024-12-21T12:00:00Z'), 90, 0);
    expect(npWinter.alwaysDown).toBe(true);

    // South Pole mirrors the North Pole.
    const spSummer = sunTimes(new Date('2024-12-21T12:00:00Z'), -90, 0);
    expect(spSummer.alwaysUp).toBe(true);
  });

  // Every other sunTimes test sits on the prime meridian, so the `- 4 * longitude`
  // term in solarNoonMinutes was free: flipping its sign left the suite green while
  // shifting sunrise/sunset by 8 minutes per degree of longitude (over an hour for
  // a central-European site).
  it('shifts solar noon 4 minutes earlier per degree of EAST longitude', () => {
    const instant = new Date('2024-06-20T12:00:00Z');
    const atMeridian = sunTimes(instant, 47, 0);
    const east15 = sunTimes(instant, 47, 15);
    const west15 = sunTimes(instant, 47, -15);

    // 15° east == one hour of longitude: the sun crosses the meridian an hour
    // EARLIER in UTC, and an hour later 15° west. Sign and magnitude both pinned.
    const hour = 3_600_000;
    expect(east15.solarNoon.getTime()).toBe(atMeridian.solarNoon.getTime() - hour);
    expect(west15.solarNoon.getTime()).toBe(atMeridian.solarNoon.getTime() + hour);

    // Sunrise/sunset ride the same shift (the hour angle is longitude-independent).
    expect(east15.sunrise!.getTime()).toBe(atMeridian.sunrise!.getTime() - hour);
    expect(east15.sunset!.getTime()).toBe(atMeridian.sunset!.getTime() - hour);
  });

  // The 90°50′ sunrise zenith bakes in atmospheric refraction + the solar semi-
  // diameter. Dropping it to a geometric 90° kept every existing test green
  // (they all use `toBeCloseTo(12, 0)`), yet moves sunrise ~3 minutes.
  it('applies the 90°50′ refraction correction, so the equinox day exceeds 12 h', () => {
    // At the equator on the equinox the geometric day is 12 h exactly; refraction
    // is the ONLY thing that can lengthen it. ~12 h 07 m is the textbook value.
    const t = sunTimes(new Date('2024-03-20T12:00:00Z'), 0, 0);
    const hours = (t.sunset!.getTime() - t.sunrise!.getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(12.08);
    expect(hours).toBeCloseTo(12.111, 2);
  });

  // At an exact pole the hour-angle formula divides by cos(lat) = 0, so the
  // always-up decision is made from the declination alone. That comparison is
  // against MINUS the refraction allowance; using plus only differs while the
  // declination sits inside the ±0.833° band — i.e. the days around an equinox,
  // which no existing fixture visits.
  it('counts the refraction band as daylight at an exact pole around the equinox', () => {
    // 2024-03-18: declination ≈ −0.64°, geometrically below the horizon but
    // inside the 0.833° refraction allowance → the sun still counts as up.
    const inBand = sunTimes(new Date('2024-03-18T12:00:00Z'), 90, 0);
    expect(inBand.alwaysUp).toBe(true);
    expect(inBand.alwaysDown).toBe(false);

    // 2024-03-10: declination ≈ −3.8°, clear of the band → polar night. Pins the
    // other side of the comparison so the test cannot pass by always answering up.
    const belowBand = sunTimes(new Date('2024-03-10T12:00:00Z'), 90, 0);
    expect(belowBand.alwaysUp).toBe(false);
    expect(belowBand.alwaysDown).toBe(true);
  });
});

describe('sunPosition longitude handling', () => {
  // Every other sunPosition test uses longitude 0, leaving the `+ 4 * longitude`
  // term in the true-solar-time conversion unpinned: flipping its sign kept the
  // whole suite green while moving the sun by 20° of azimuth per 15° of longitude.
  it('reaches solar noon earlier in UTC the further east the site is', () => {
    const equinox = '2024-03-20';
    // Solar noon at 15°E is ~11:07 UTC, so at 12:00 UTC the sun is already past
    // the meridian (azimuth > 180°); at 15°W it has not reached it yet (< 180°).
    const east = sunPosition(new Date(`${equinox}T12:00:00Z`), 47, 15);
    const west = sunPosition(new Date(`${equinox}T12:00:00Z`), 47, -15);

    expect(east.azimuth).toBeGreaterThan(180);
    expect(west.azimuth).toBeLessThan(180);
    // 30° of longitude == 2 h of hour angle == 30° of hour angle either side.
    expect(east.azimuth - west.azimuth).toBeGreaterThan(30);
  });
});
