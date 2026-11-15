/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  approxLv95FromWgs84BBox,
  assertLv95BBox,
  clipRingToBBox,
  lv95ToWgs84Approx,
  paddedWgs84BBox,
  polygonArea,
  wgs84ToLv95Approx,
} from '../src/lv95.js';
import type { StacItem } from '../src/stac.js';
import { fixture } from './helpers/mock-fetch.js';

/** ~1 m at Swiss latitudes, in degrees of latitude. */
const METRE_DEG = 1 / 111_000;

describe('approximate LV95 ↔ WGS84', () => {
  it('matches the bbox swisstopo publishes for STAC tile 2600-1199 to within ~2 m', () => {
    const item = fixture<{ features: StacItem[] }>('stac-swissalti3d-items-2600-1199.json').features[0];
    const [w, s, e, n] = item.bbox;
    const sw = lv95ToWgs84Approx(2_600_000, 1_199_000);
    const ne = lv95ToWgs84Approx(2_601_000, 1_200_000);
    expect(Math.abs(sw.lon - w)).toBeLessThan(2 * METRE_DEG * 1.5);
    expect(Math.abs(sw.lat - s)).toBeLessThan(2 * METRE_DEG);
    expect(Math.abs(ne.lon - e)).toBeLessThan(2 * METRE_DEG * 1.5);
    expect(Math.abs(ne.lat - n)).toBeLessThan(2 * METRE_DEG);
  });

  it('round-trips within 3 m across Switzerland (0.4 m at Bern, 2.7 m near Geneva)', () => {
    for (const [e0, n0] of [
      [2_600_000, 1_200_000],
      [2_485_000, 1_110_000],
      [2_830_000, 1_180_000],
    ]) {
      const { lon, lat } = lv95ToWgs84Approx(e0, n0);
      const { e, n } = wgs84ToLv95Approx(lon, lat);
      expect(Math.hypot(e - e0, n - n0)).toBeLessThan(3);
    }
  });

  it('pads the WGS84 query box so it contains the LV95 box with margin', () => {
    const box = { minX: 2_600_200, minY: 1_199_200, maxX: 2_600_800, maxY: 1_199_900 };
    const padded = paddedWgs84BBox(box, 50);
    const back = approxLv95FromWgs84BBox(padded);
    expect(back.minX).toBeLessThan(box.minX - 50);
    expect(back.minY).toBeLessThan(box.minY - 50);
    expect(back.maxX).toBeGreaterThan(box.maxX + 50);
    expect(back.maxY).toBeGreaterThan(box.maxY + 50);
  });
});

describe('LV95 box validation', () => {
  it('rejects degree boxes, swapped axes and inverted boxes', () => {
    expect(() => assertLv95BBox({ minX: 7.4, minY: 46.9, maxX: 7.5, maxY: 47 })).toThrow(/not in LV95/);
    expect(() => assertLv95BBox({ minX: 1_199_000, minY: 2_600_000, maxX: 1_200_000, maxY: 2_601_000 })).toThrow(/not in LV95/);
    expect(() => assertLv95BBox({ minX: 2_601_000, minY: 1_199_000, maxX: 2_600_000, maxY: 1_200_000 })).toThrow(/minX < maxX/);
    expect(() => assertLv95BBox({ minX: 2_600_000, minY: 1_199_000, maxX: 2_601_000, maxY: 1_200_000 })).not.toThrow();
  });
});

describe('geometry helpers', () => {
  it('computes area with holes subtracted', () => {
    const square = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const hole = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]];
    expect(polygonArea({ type: 'Polygon', coordinates: [square, hole] })).toBe(96);
    expect(polygonArea({ type: 'MultiPolygon', coordinates: [[square], [hole]] })).toBe(104);
  });

  it('clips a ring to a box and drops rings outside it', () => {
    const tri = [[0, 0], [10, 0], [0, 10], [0, 0]];
    const clipped = clipRingToBBox(tri, { minX: 0, minY: 0, maxX: 5, maxY: 5 });
    expect(clipped[0]).toEqual(clipped[clipped.length - 1]);
    expect(polygonArea({ type: 'Polygon', coordinates: [clipped] })).toBe(25);
    expect(clipRingToBBox(tri, { minX: 20, minY: 20, maxX: 30, maxY: 30 })).toEqual([]);
  });
});
