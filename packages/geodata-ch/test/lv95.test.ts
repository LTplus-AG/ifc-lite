/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import * as publicApi from '../src/index.js';
import {
  APPROX_ERROR_ALLOWANCE_METRES,
  approxLv95FromWgs84BBox,
  assertLv95BBox,
  assertLv95Point,
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

describe('approximate formulas: measured accuracy and public surface', () => {
  // Official swisstopo reframe service (geodesy.geo.admin.ch/reframe/lv95towgs84), recorded 2026-11-15.
  const OFFICIAL = [
    { e: 2_600_000, n: 1_200_000, lon: 7.438632495274896, lat: 46.951082876677035, maxErr: 0.5 },
    { e: 2_485_000, n: 1_110_000, lon: 5.950612449020602, lat: 46.13165669432483, maxErr: 3.2 },
    { e: 2_830_000, n: 1_080_000, lon: 10.39901421311893, lat: 45.83258095768311, maxErr: 3.3 },
  ];
  const metres = (a: { lon: number; lat: number }, b: { lon: number; lat: number }): number =>
    Math.hypot((a.lon - b.lon) * 111_195 * Math.cos((b.lat * Math.PI) / 180), (a.lat - b.lat) * 111_195);

  it('stays within the errors measured against the official service: sub-metre centrally, ~3 m at the periphery', () => {
    const errs = OFFICIAL.map((o) => metres(lv95ToWgs84Approx(o.e, o.n), o));
    OFFICIAL.forEach((o, i) => expect(errs[i]).toBeLessThan(o.maxErr));
    expect(errs[1]).toBeGreaterThan(2.5); // the "about 1 m" claim would be false here
    expect(errs[2]).toBeGreaterThan(2.5);
  });

  it('pads a query box with margin over the worst measured error, even with no caller padding', () => {
    const o = OFFICIAL[1];
    const box = { minX: o.e, minY: o.n, maxX: o.e + 500, maxY: o.n + 500 };
    const [w, s] = paddedWgs84BBox(box, 0);
    // The official position of the box's south-west corner lies inside the padded box by at least 5 m.
    expect(o.lon - w).toBeGreaterThan(5 / (111_195 * Math.cos((o.lat * Math.PI) / 180)));
    expect(o.lat - s).toBeGreaterThan(5 / 111_195);
    expect(APPROX_ERROR_ALLOWANCE_METRES).toBeGreaterThanOrEqual(3 * 3.04);
  });

  it('does not export the approximate conversions from the package', () => {
    for (const name of ['lv95ToWgs84Approx', 'wgs84ToLv95Approx', 'paddedWgs84BBox']) {
      expect(publicApi).not.toHaveProperty(name);
    }
  });
});

describe('LV95 point validation', () => {
  it('accepts a point in Switzerland', () => {
    expect(() => assertLv95Point(2_600_423, 1_199_521)).not.toThrow();
  });

  it('says the arguments look swapped when northing and easting are exchanged', () => {
    expect(() => assertLv95Point(1_199_521, 2_600_423)).toThrow(/look swapped/);
    expect(() => assertLv95Point(1_199_521, 2_600_423)).toThrow(RangeError);
  });

  it('rejects degrees and non-finite values', () => {
    expect(() => assertLv95Point(7.44, 46.95)).toThrow(/not in LV95/);
    expect(() => assertLv95Point(Number.NaN, 1_199_521)).toThrow(/finite/);
  });

  it('names swapped axes in a bbox error too', () => {
    expect(() => assertLv95BBox({ minX: 1_199_000, minY: 2_600_000, maxX: 1_200_000, maxY: 2_601_000 })).toThrow(/swapped/);
  });
});

