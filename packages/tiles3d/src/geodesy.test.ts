/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { ecefToGeodetic, geodeticToEcef, WGS84_A, WGS84_F } from './geodesy.js';

const B = WGS84_A * (1 - WGS84_F);

describe('geodetic <-> ECEF', () => {
  it('matches the GeographicLib CartConvert documentation example', () => {
    // GeographicLib docs: 33.3N 44.4E 6000 m -> 3816209.60 3737108.55 3485109.57
    const [x, y, z] = geodeticToEcef(44.4, 33.3, 6000);
    expect(x).toBeCloseTo(3816209.6, 1);
    expect(y).toBeCloseTo(3737108.55, 1);
    expect(z).toBeCloseTo(3485109.57, 1);
    const g = ecefToGeodetic(3816209.6, 3737108.55, 3485109.57);
    expect(g.lat).toBeCloseTo(33.3, 7);
    expect(g.lon).toBeCloseTo(44.4, 7);
    expect(g.height).toBeCloseTo(6000, 2);
  });

  it('handles the axes and poles exactly', () => {
    expect(ecefToGeodetic(WGS84_A, 0, 0)).toEqual({ lon: 0, lat: 0, height: expect.closeTo(0, 6) });
    const east = ecefToGeodetic(0, WGS84_A + 1000, 0);
    expect(east.lon).toBeCloseTo(90, 10);
    expect(east.height).toBeCloseTo(1000, 6);
    const north = ecefToGeodetic(0, 0, B + 250);
    expect(north.lat).toBeCloseTo(90, 10);
    expect(north.height).toBeCloseTo(250, 6);
    const south = ecefToGeodetic(0, 0, -B);
    expect(south.lat).toBeCloseTo(-90, 10);
    expect(south.height).toBeCloseTo(0, 6);
  });

  it('round-trips to sub-millimetre accuracy across latitudes and heights', () => {
    let worst = 0;
    for (let lat = -89.5; lat <= 89.5; lat += 7.3) {
      for (let lon = -179; lon <= 180; lon += 23.7) {
        for (const h of [-430, 0, 549.9, 4634, 35_786_000]) {
          const [x, y, z] = geodeticToEcef(lon, lat, h);
          const g = ecefToGeodetic(x, y, z);
          const [x2, y2, z2] = geodeticToEcef(g.lon, g.lat, g.height);
          worst = Math.max(worst, Math.hypot(x - x2, y - y2, z - z2), Math.abs(g.height - h) / Math.max(1, Math.abs(h) / 1e6));
        }
      }
    }
    expect(worst).toBeLessThan(1e-3);
  });

  it('refuses points near the Earth centre instead of returning garbage', () => {
    expect(() => ecefToGeodetic(1000, 0, 0)).toThrow(RangeError);
  });
});
