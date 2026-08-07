/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  azimuthAltitudeToEnu,
  dayPath,
  analemmaPaths,
  domeGraticule,
} from './sun-path.js';

const LAT = 51.4769;
const LON = 0;

describe('azimuthAltitudeToEnu', () => {
  it('maps north/east/up correctly', () => {
    const north = azimuthAltitudeToEnu(0, 0);
    expect(north.n).toBeCloseTo(1, 6);
    expect(north.e).toBeCloseTo(0, 6);

    const east = azimuthAltitudeToEnu(90, 0);
    expect(east.e).toBeCloseTo(1, 6);
    expect(east.n).toBeCloseTo(0, 6);

    const zenith = azimuthAltitudeToEnu(0, 90);
    expect(zenith.u).toBeCloseTo(1, 6);
  });

  it('returns unit-length vectors', () => {
    for (const [az, alt] of [[37, 12], [200, 55], [310, 80]] as const) {
      const v = azimuthAltitudeToEnu(az, alt);
      const len = Math.hypot(v.e, v.n, v.u);
      expect(len).toBeCloseTo(1, 6);
    }
  });
});

describe('dayPath', () => {
  it('returns an above-horizon arc ordered through the day', () => {
    const arc = dayPath(new Date('2024-06-20T12:00:00Z'), LAT, LON, { stepMinutes: 15 });
    expect(arc.length).toBeGreaterThan(10);
    expect(arc.every((s) => s.aboveHorizon && s.dir.u >= 0)).toBe(true);
    for (let i = 1; i < arc.length; i++) {
      expect(arc[i].time.getTime()).toBeGreaterThan(arc[i - 1].time.getTime());
    }
  });

  it('can include below-horizon samples when asked', () => {
    const all = dayPath(new Date('2024-06-20T12:00:00Z'), LAT, LON, {
      stepMinutes: 30,
      aboveHorizonOnly: false,
    });
    expect(all.some((s) => !s.aboveHorizon)).toBe(true);
    expect(all.some((s) => s.aboveHorizon)).toBe(true);
  });

  // The sampling loop is `m <= 1440`, i.e. inclusive of the closing midnight, so
  // a day yields 1440/step + 1 samples and the polyline closes on the next day's
  // start. No test pinned the count, so `m < 1440` (dropping the closing sample)
  // went unnoticed — a renderer drawing a closed dome arc would show a gap.
  it('samples the whole UTC day inclusive of the closing midnight', () => {
    const day = new Date('2024-06-20T12:00:00Z');
    const all = dayPath(day, LAT, LON, { stepMinutes: 60, aboveHorizonOnly: false });

    expect(all).toHaveLength(1440 / 60 + 1);
    expect(all[0].time.toISOString()).toBe('2024-06-20T00:00:00.000Z');
    expect(all[all.length - 1].time.toISOString()).toBe('2024-06-21T00:00:00.000Z');
  });

  it('traces a longer summer arc than a winter arc', () => {
    const summer = dayPath(new Date('2024-06-20T12:00:00Z'), LAT, LON, { stepMinutes: 10 });
    const winter = dayPath(new Date('2024-12-21T12:00:00Z'), LAT, LON, { stepMinutes: 10 });
    expect(summer.length).toBeGreaterThan(winter.length);
  });

  // `for (let m = 0; m <= 1440; m += step)` never advances when step <= 0,
  // hanging the process instead of returning or throwing. Confirmed live via
  // direct probe: `dayPath(date, 51.5, -0.1, { stepMinutes: 0 })` ran past a
  // 5-second external `timeout` wrapper without returning (exit code 124)
  // before this guard existed.
  it('rejects a non-positive stepMinutes instead of hanging', () => {
    expect(() => dayPath(new Date('2024-06-20T12:00:00Z'), LAT, LON, { stepMinutes: 0 })).toThrow(/stepMinutes/);
    expect(() => dayPath(new Date('2024-06-20T12:00:00Z'), LAT, LON, { stepMinutes: -5 })).toThrow(/stepMinutes/);
    expect(() => dayPath(new Date('2024-06-20T12:00:00Z'), LAT, LON, { stepMinutes: NaN })).toThrow(/stepMinutes/);
  });
});

describe('analemmaPaths', () => {
  it('produces hour curves that all reach above the horizon', () => {
    const paths = analemmaPaths(2024, LAT, LON, { dayStep: 10 });
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.samples.some((s) => s.aboveHorizon)).toBe(true);
      expect(p.hour).toBeGreaterThanOrEqual(0);
      expect(p.hour).toBeLessThan(24);
    }
  });

  // The year length comes from a Gregorian leap-year test. Nothing asserted the
  // sample count, so hard-coding 365 stayed green while silently truncating a
  // leap year's analemma before 31 December.
  it('walks every calendar day, honouring Gregorian leap years', () => {
    const lengthFor = (year: number): number =>
      analemmaPaths(year, LAT, LON, { dayStep: 1 })[0].samples.length;

    expect(lengthFor(2024)).toBe(366); // divisible by 4
    expect(lengthFor(2023)).toBe(365); // common year
    expect(lengthFor(2100)).toBe(365); // century, not divisible by 400
    expect(lengthFor(2000)).toBe(366); // divisible by 400
  });

  it('includes a midday analemma but not a deep-night one in the UK', () => {
    const hours = analemmaPaths(2024, LAT, LON, { dayStep: 10 }).map((p) => p.hour);
    expect(hours).toContain(12);
    expect(hours).not.toContain(1);
  });

  // Same shape as dayPath's stepMinutes bug: `for (day=0; day<daysInYear;
  // day+=dayStep)` never advances when dayStep <= 0.
  it('rejects a non-positive dayStep instead of hanging', () => {
    expect(() => analemmaPaths(2024, LAT, LON, { dayStep: 0 })).toThrow(/dayStep/);
    expect(() => analemmaPaths(2024, LAT, LON, { dayStep: -3 })).toThrow(/dayStep/);
  });
});

describe('domeGraticule', () => {
  it('includes the horizon ring and eight cardinal labels', () => {
    const g = domeGraticule();
    expect(g.altitudeRings[0].altitude).toBe(0);
    expect(g.cardinals).toHaveLength(8);
    const north = g.cardinals.find((c) => c.label === 'N')!;
    expect(north.dir.n).toBeCloseTo(1, 6);
  });

  it('builds altitude rings and azimuth spokes at the requested spacing', () => {
    const g = domeGraticule({ altitudeStep: 30, azimuthStep: 90 });
    // Horizon (0) + 30 + 60 = 3 rings.
    expect(g.altitudeRings.map((r) => r.altitude)).toEqual([0, 30, 60]);
    // 0,90,180,270 → 4 spokes.
    expect(g.azimuthSpokes).toHaveLength(4);
  });

  // A non-positive step/resolution used to make the `for (...; x += step)` loop
  // never advance — a caller-supplied `0` (or negative) option value hung the
  // process instead of returning or throwing. Confirmed live: `dayPath(date,
  // lat, lon, { stepMinutes: 0 })` did not return within a 5s external
  // timeout before this guard was added.
  it('rejects a non-positive resolution/altitudeStep/azimuthStep instead of hanging', () => {
    expect(() => domeGraticule({ resolution: 0 })).toThrow(/resolution/);
    expect(() => domeGraticule({ resolution: -5 })).toThrow(/resolution/);
    expect(() => domeGraticule({ altitudeStep: 0 })).toThrow(/altitudeStep/);
    expect(() => domeGraticule({ azimuthStep: -1 })).toThrow(/azimuthStep/);
    expect(() => domeGraticule({ resolution: NaN })).toThrow(/resolution/);
  });
});
