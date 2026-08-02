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

  it('traces a longer summer arc than a winter arc', () => {
    const summer = dayPath(new Date('2024-06-20T12:00:00Z'), LAT, LON, { stepMinutes: 10 });
    const winter = dayPath(new Date('2024-12-21T12:00:00Z'), LAT, LON, { stepMinutes: 10 });
    expect(summer.length).toBeGreaterThan(winter.length);
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

  it('includes a midday analemma but not a deep-night one in the UK', () => {
    const hours = analemmaPaths(2024, LAT, LON, { dayStep: 10 }).map((p) => p.hour);
    expect(hours).toContain(12);
    expect(hours).not.toContain(1);
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
});
