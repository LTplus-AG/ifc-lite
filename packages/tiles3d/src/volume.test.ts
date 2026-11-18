/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { enuToEcefMatrix, geodeticToEcef } from './geodesy.js';
import { IDENTITY, multiply } from './matrix.js';
import { prepareRegion, volumeIntersects } from './volume.js';
import { regionRad } from '../test/support.js';

// A 100 m box around a point in Bern.
const LON = 7.44, LAT = 46.95;
const dLat = 50 / 111_320, dLon = 50 / (111_320 * Math.cos((LAT * Math.PI) / 180));
const query = prepareRegion({ west: LON - dLon, east: LON + dLon, south: LAT - dLat, north: LAT + dLat });

describe('region volumes', () => {
  it('culls on both sides of the query boundary', () => {
    expect(volumeIntersects(query, { region: regionRad(LON + dLon * 0.9, LAT, LON + 0.01, LAT + 0.01) }, IDENTITY)).toBe(true);
    expect(volumeIntersects(query, { region: regionRad(LON + dLon * 1.1, LAT, LON + 0.01, LAT + 0.01) }, IDENTITY)).toBe(false);
  });

  it('ignores the tile transform, as the specification requires for regions', () => {
    const shifted = multiply(IDENTITY, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1e6, 0, 0, 1]);
    expect(volumeIntersects(query, { region: regionRad(LON - 0.001, LAT - 0.001, LON + 0.001, LAT + 0.001) }, shifted)).toBe(true);
  });

  it('honours height ranges', () => {
    const q = prepareRegion({ west: 7, east: 8, south: 46, north: 47, minHeight: 0, maxHeight: 100 });
    expect(volumeIntersects(q, { region: regionRad(7.1, 46.1, 7.2, 46.2, 200, 300) }, IDENTITY)).toBe(false);
    expect(volumeIntersects(q, { region: regionRad(7.1, 46.1, 7.2, 46.2, 50, 300) }, IDENTITY)).toBe(true);
  });

  it('supports regions and queries across the antimeridian', () => {
    const q = prepareRegion({ west: 179.5, east: -179.5, south: -1, north: 1 });
    expect(volumeIntersects(q, { region: regionRad(-179.9, -0.5, -179.8, 0.5) }, IDENTITY)).toBe(true);
    expect(volumeIntersects(q, { region: regionRad(-170, -0.5, -169, 0.5) }, IDENTITY)).toBe(false);
    const qNormal = prepareRegion({ west: 10, east: 11, south: -1, north: 1 });
    expect(volumeIntersects(qNormal, { region: [3.1, -0.01, -3.1, 0.01, 0, 10] }, IDENTITY)).toBe(false);
  });
});

describe('box and sphere volumes under a transform chain', () => {
  // A local east-north-up frame 120 m east of the query centre, reached through two transforms.
  // Parent: ENU frame 100 m east of the query centre. Child: +20 m east of that.
  const parent = enuToEcefMatrix(LON + (100 / 50) * dLon, LAT, 500);
  const child = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 20, 0, 0, 1];
  const chain = multiply(parent, child);

  it('keeps a box whose west face reaches into the query and drops one 10 m short', () => {
    // Box centred on the local origin; query edge is 70 m west of it.
    const reaching = [0, 0, 0, 75, 0, 0, 0, 20, 0, 0, 0, 20];
    const short = [0, 0, 0, 60, 0, 0, 0, 20, 0, 0, 0, 20];
    expect(volumeIntersects(query, { box: reaching }, chain)).toBe(true);
    expect(volumeIntersects(query, { box: short }, chain)).toBe(false);
  });

  it('applies the transform scale to a sphere radius', () => {
    const scaled = multiply(chain, [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
    expect(volumeIntersects(query, { sphere: [0, 0, 0, 40] }, chain)).toBe(false);
    expect(volumeIntersects(query, { sphere: [0, 0, 0, 40] }, scaled)).toBe(true);
  });

  it('works for a box given directly in ECEF (identity transform)', () => {
    const c = geodeticToEcef(LON, LAT, 500);
    expect(volumeIntersects(query, { box: [...c, 10, 0, 0, 0, 10, 0, 0, 0, 10] }, IDENTITY)).toBe(true);
    const far = geodeticToEcef(LON + 0.01, LAT, 500);
    expect(volumeIntersects(query, { box: [...far, 10, 0, 0, 0, 10, 0, 0, 0, 10] }, IDENTITY)).toBe(false);
  });

  it('reports a volume it cannot interpret instead of guessing', () => {
    expect(volumeIntersects(query, { extensions: { '3DTILES_bounding_volume_S2': {} } }, IDENTITY)).toBeUndefined();
  });

  it('rejects malformed query regions', () => {
    expect(() => prepareRegion({ west: 0, east: 1, south: 2, north: 1 })).toThrow(RangeError);
    expect(() => prepareRegion({ west: 0, east: 200, south: 0, north: 1 })).toThrow(RangeError);
  });
});
